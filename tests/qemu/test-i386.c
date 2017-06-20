/*
 *  x86 CPU test
 *
 *  Copyright (c) 2003 Fabrice Bellard
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with this program; if not, see <http://www.gnu.org/licenses/>.
 */
#define _GNU_SOURCE
#include "compiler.h"
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <inttypes.h>
#include <math.h>
#include <signal.h>
#include <setjmp.h>
#include <errno.h>
#include <sys/ucontext.h>
#include <sys/mman.h>

#if !defined(__x86_64__)
//#define TEST_VM86
#define TEST_SEGS
#endif
//#define LINUX_VM86_IOPL_FIX
//#define TEST_P4_FLAGS

//#ifdef __SSE__
#if 1
#define TEST_SSE
#define TEST_CMOV  1
#define TEST_FCOMI 1
#else
#undef TEST_SSE
#define TEST_CMOV  1
#define TEST_FCOMI 1
#endif

#if defined(__x86_64__)
#define FMT64X "%016lx"
#define FMTLX "%016lx"
#define X86_64_ONLY(x) x
#else
#define FMT64X "%016" PRIx64
#define FMTLX "%08lx"
#define X86_64_ONLY(x)
#endif

#ifdef TEST_VM86
#include <asm/vm86.h>
#endif

#define xglue(x, y) x ## y
#define glue(x, y) xglue(x, y)
#define stringify(s)	tostring(s)
#define tostring(s)	#s

#define CC_C   	0x0001
#define CC_P 	0x0004
#define CC_A	0x0010
#define CC_Z	0x0040
#define CC_S    0x0080
#define CC_O    0x0800

#define __init_call	__attribute__ ((unused,__section__ ("initcall")))

#define CC_MASK (CC_C | CC_P | CC_Z | CC_S | CC_O | CC_A)

#if defined(__x86_64__)
static inline long i2l(long v)
{
    return v | ((v ^ 0xabcd) << 32);
}
#else
static inline long i2l(long v)
{
    return v;
}
#endif

#define OP add
#include "test-i386.h"

#define OP sub
#include "test-i386.h"

#define OP xor
#include "test-i386.h"

#define OP and
#include "test-i386.h"

#define OP or
#include "test-i386.h"

#define OP cmp
#include "test-i386.h"

#define OP adc
#define OP_CC
#include "test-i386.h"

#define OP sbb
#define OP_CC
#include "test-i386.h"

#define OP inc
#define OP_CC
#define OP1
#include "test-i386.h"

#define OP dec
#define OP_CC
#define OP1
#include "test-i386.h"

#define OP neg
#define OP_CC
#define OP1
#include "test-i386.h"

#define OP not
#define OP_CC
#define OP1
#include "test-i386.h"

#undef CC_MASK
#define CC_MASK (CC_C | CC_P | CC_Z | CC_S | CC_O)

#define OP shl
#include "test-i386-shift.h"

#define OP shr
#include "test-i386-shift.h"

#define OP sar
#include "test-i386-shift.h"

#define OP rol
#include "test-i386-shift.h"

#define OP ror
#include "test-i386-shift.h"

#define OP rcr
#define OP_CC
#include "test-i386-shift.h"

#define OP rcl
#define OP_CC
#include "test-i386-shift.h"

#define OP shld
#define OP_SHIFTD
#define OP_NOBYTE
#include "test-i386-shift.h"

#define OP shrd
#define OP_SHIFTD
#define OP_NOBYTE
#include "test-i386-shift.h"

/* XXX: should be more precise ? */
#undef CC_MASK
#define CC_MASK (CC_C)

#define OP bt
#define OP_NOBYTE
#include "test-i386-shift.h"

#define OP bts
#define OP_NOBYTE
#include "test-i386-shift.h"

#define OP btr
#define OP_NOBYTE
#include "test-i386-shift.h"

#define OP btc
#define OP_NOBYTE
#include "test-i386-shift.h"

/* lea test (modrm support) */
#define TEST_LEAQ(STR)\
{\
    asm("lea " STR ", %0"\
        : "=r" (res)\
        : "a" (eax), "b" (ebx), "c" (ecx), "d" (edx), "S" (esi), "D" (edi));\
    printf("lea %s = " FMTLX "\n", STR, res);\
}

#define TEST_LEA(STR)\
{\
    asm("lea " STR ", %0"\
        : "=r" (res)\
        : "a" (eax), "b" (ebx), "c" (ecx), "d" (edx), "S" (esi), "D" (edi));\
    printf("lea %s = " FMTLX "\n", STR, res);\
}

#define TEST_LEA16(STR)\
{\
    asm(".code16 ; .byte 0x67 ; leal " STR ", %0 ; .code32"\
        : "=wq" (res)\
        : "a" (eax), "b" (ebx), "c" (ecx), "d" (edx), "S" (esi), "D" (edi));\
    printf("lea %s = %08lx\n", STR, res);\
}


void test_lea(void)
{
    long eax, ebx, ecx, edx, esi, edi, res;
    eax = i2l(0x0001);
    ebx = i2l(0x0002);
    ecx = i2l(0x0004);
    edx = i2l(0x0008);
    esi = i2l(0x0010);
    edi = i2l(0x0020);

    TEST_LEA("0x4000");

    TEST_LEA("(%%eax)");
    TEST_LEA("(%%ebx)");
    TEST_LEA("(%%ecx)");
    TEST_LEA("(%%edx)");
    TEST_LEA("(%%esi)");
    TEST_LEA("(%%edi)");

    TEST_LEA("0x40(%%eax)");
    TEST_LEA("0x40(%%ebx)");
    TEST_LEA("0x40(%%ecx)");
    TEST_LEA("0x40(%%edx)");
    TEST_LEA("0x40(%%esi)");
    TEST_LEA("0x40(%%edi)");

    TEST_LEA("0x4000(%%eax)");
    TEST_LEA("0x4000(%%ebx)");
    TEST_LEA("0x4000(%%ecx)");
    TEST_LEA("0x4000(%%edx)");
    TEST_LEA("0x4000(%%esi)");
    TEST_LEA("0x4000(%%edi)");

    TEST_LEA("(%%eax, %%ecx)");
    TEST_LEA("(%%ebx, %%edx)");
    TEST_LEA("(%%ecx, %%ecx)");
    TEST_LEA("(%%edx, %%ecx)");
    TEST_LEA("(%%esi, %%ecx)");
    TEST_LEA("(%%edi, %%ecx)");

    TEST_LEA("0x40(%%eax, %%ecx)");
    TEST_LEA("0x4000(%%ebx, %%edx)");

    TEST_LEA("(%%ecx, %%ecx, 2)");
    TEST_LEA("(%%edx, %%ecx, 4)");
    TEST_LEA("(%%esi, %%ecx, 8)");

    TEST_LEA("(,%%eax, 2)");
    TEST_LEA("(,%%ebx, 4)");
    TEST_LEA("(,%%ecx, 8)");

    TEST_LEA("0x40(,%%eax, 2)");
    TEST_LEA("0x40(,%%ebx, 4)");
    TEST_LEA("0x40(,%%ecx, 8)");


    TEST_LEA("-10(%%ecx, %%ecx, 2)");
    TEST_LEA("-10(%%edx, %%ecx, 4)");
    TEST_LEA("-10(%%esi, %%ecx, 8)");

    TEST_LEA("0x4000(%%ecx, %%ecx, 2)");
    TEST_LEA("0x4000(%%edx, %%ecx, 4)");
    TEST_LEA("0x4000(%%esi, %%ecx, 8)");

#if defined(__x86_64__)
    TEST_LEAQ("0x4000");
    TEST_LEAQ("0x4000(%%rip)");

    TEST_LEAQ("(%%rax)");
    TEST_LEAQ("(%%rbx)");
    TEST_LEAQ("(%%rcx)");
    TEST_LEAQ("(%%rdx)");
    TEST_LEAQ("(%%rsi)");
    TEST_LEAQ("(%%rdi)");

    TEST_LEAQ("0x40(%%rax)");
    TEST_LEAQ("0x40(%%rbx)");
    TEST_LEAQ("0x40(%%rcx)");
    TEST_LEAQ("0x40(%%rdx)");
    TEST_LEAQ("0x40(%%rsi)");
    TEST_LEAQ("0x40(%%rdi)");

    TEST_LEAQ("0x4000(%%rax)");
    TEST_LEAQ("0x4000(%%rbx)");
    TEST_LEAQ("0x4000(%%rcx)");
    TEST_LEAQ("0x4000(%%rdx)");
    TEST_LEAQ("0x4000(%%rsi)");
    TEST_LEAQ("0x4000(%%rdi)");

    TEST_LEAQ("(%%rax, %%rcx)");
    TEST_LEAQ("(%%rbx, %%rdx)");
    TEST_LEAQ("(%%rcx, %%rcx)");
    TEST_LEAQ("(%%rdx, %%rcx)");
    TEST_LEAQ("(%%rsi, %%rcx)");
    TEST_LEAQ("(%%rdi, %%rcx)");

    TEST_LEAQ("0x40(%%rax, %%rcx)");
    TEST_LEAQ("0x4000(%%rbx, %%rdx)");

    TEST_LEAQ("(%%rcx, %%rcx, 2)");
    TEST_LEAQ("(%%rdx, %%rcx, 4)");
    TEST_LEAQ("(%%rsi, %%rcx, 8)");

    TEST_LEAQ("(,%%rax, 2)");
    TEST_LEAQ("(,%%rbx, 4)");
    TEST_LEAQ("(,%%rcx, 8)");

    TEST_LEAQ("0x40(,%%rax, 2)");
    TEST_LEAQ("0x40(,%%rbx, 4)");
    TEST_LEAQ("0x40(,%%rcx, 8)");


    TEST_LEAQ("-10(%%rcx, %%rcx, 2)");
    TEST_LEAQ("-10(%%rdx, %%rcx, 4)");
    TEST_LEAQ("-10(%%rsi, %%rcx, 8)");

    TEST_LEAQ("0x4000(%%rcx, %%rcx, 2)");
    TEST_LEAQ("0x4000(%%rdx, %%rcx, 4)");
    TEST_LEAQ("0x4000(%%rsi, %%rcx, 8)");
#else
    /* limited 16 bit addressing test */
    //TEST_LEA16("0x4000");
    //TEST_LEA16("(%%bx)");
    //TEST_LEA16("(%%si)");
    //TEST_LEA16("(%%di)");
    //TEST_LEA16("0x40(%%bx)");
    //TEST_LEA16("0x40(%%si)");
    //TEST_LEA16("0x40(%%di)");
    //TEST_LEA16("0x4000(%%bx)");
    //TEST_LEA16("0x4000(%%si)");
    //TEST_LEA16("(%%bx,%%si)");
    //TEST_LEA16("(%%bx,%%di)");
    //TEST_LEA16("0x40(%%bx,%%si)");
    //TEST_LEA16("0x40(%%bx,%%di)");
    //TEST_LEA16("0x4000(%%bx,%%si)");
    //TEST_LEA16("0x4000(%%bx,%%di)");
#endif
}

#define TEST_JCC(JCC, v1, v2)\
{\
    int res;\
    asm("movl $1, %0\n\t"\
        "cmpl %2, %1\n\t"\
        "j" JCC " 1f\n\t"\
        "movl $0, %0\n\t"\
        "1:\n\t"\
        : "=r" (res)\
        : "r" (v1), "r" (v2));\
    printf("%-10s %d\n", "j" JCC, res);\
\
    asm("movl $0, %0\n\t"\
        "cmpl %2, %1\n\t"\
        "set" JCC " %b0\n\t"\
        : "=r" (res)\
        : "r" (v1), "r" (v2));\
    printf("%-10s %d\n", "set" JCC, res);\
 if (TEST_CMOV) {\
    long val = i2l(1);\
    long res = i2l(0x12345678);\
X86_64_ONLY(\
    asm("cmpl %2, %1\n\t"\
        "cmov" JCC "q %3, %0\n\t"\
        : "=r" (res)\
        : "r" (v1), "r" (v2), "m" (val), "0" (res));\
        printf("%-10s R=" FMTLX "\n", "cmov" JCC "q", res);)\
    asm("cmpl %2, %1\n\t"\
        "cmov" JCC "l %k3, %k0\n\t"\
        : "=r" (res)\
        : "r" (v1), "r" (v2), "m" (val), "0" (res));\
        printf("%-10s R=" FMTLX "\n", "cmov" JCC "l", res);\
    asm("cmpl %2, %1\n\t"\
        "cmov" JCC "w %w3, %w0\n\t"\
        : "=r" (res)\
        : "r" (v1), "r" (v2), "r" (1), "0" (res));\
        printf("%-10s R=" FMTLX "\n", "cmov" JCC "w", res);\
 } \
}

/* various jump tests */
void test_jcc(void)
{
    TEST_JCC("ne", 1, 1);
    TEST_JCC("ne", 1, 0);

    TEST_JCC("e", 1, 1);
    TEST_JCC("e", 1, 0);

    TEST_JCC("l", 1, 1);
    TEST_JCC("l", 1, 0);
    TEST_JCC("l", 1, -1);

    TEST_JCC("le", 1, 1);
    TEST_JCC("le", 1, 0);
    TEST_JCC("le", 1, -1);

    TEST_JCC("ge", 1, 1);
    TEST_JCC("ge", 1, 0);
    TEST_JCC("ge", -1, 1);

    TEST_JCC("g", 1, 1);
    TEST_JCC("g", 1, 0);
    TEST_JCC("g", 1, -1);

    TEST_JCC("b", 1, 1);
    TEST_JCC("b", 1, 0);
    TEST_JCC("b", 1, -1);

    TEST_JCC("be", 1, 1);
    TEST_JCC("be", 1, 0);
    TEST_JCC("be", 1, -1);

    TEST_JCC("ae", 1, 1);
    TEST_JCC("ae", 1, 0);
    TEST_JCC("ae", 1, -1);

    TEST_JCC("a", 1, 1);
    TEST_JCC("a", 1, 0);
    TEST_JCC("a", 1, -1);


    TEST_JCC("p", 1, 1);
    TEST_JCC("p", 1, 0);

    TEST_JCC("np", 1, 1);
    TEST_JCC("np", 1, 0);

    TEST_JCC("o", 0x7fffffff, 0);
    TEST_JCC("o", 0x7fffffff, -1);

    TEST_JCC("no", 0x7fffffff, 0);
    TEST_JCC("no", 0x7fffffff, -1);

    TEST_JCC("s", 0, 1);
    TEST_JCC("s", 0, -1);
    TEST_JCC("s", 0, 0);

    TEST_JCC("ns", 0, 1);
    TEST_JCC("ns", 0, -1);
    TEST_JCC("ns", 0, 0);
}

#define TEST_LOOP(insn) \
{\
    for(i = 0; i < sizeof(ecx_vals) / sizeof(long); i++) {\
        ecx = ecx_vals[i];\
        for(zf = 0; zf < 2; zf++) {\
    asm("test %2, %2\n\t"\
        "movl $1, %0\n\t"\
          insn " 1f\n\t" \
        "movl $0, %0\n\t"\
        "1:\n\t"\
        : "=a" (res)\
        : "c" (ecx), "b" (!zf)); \
    printf("%-10s ECX=" FMTLX " ZF=%ld r=%d\n", insn, ecx, zf, res);      \
        }\
   }\
}

void test_loop(void)
{
    long ecx, zf;
    const long ecx_vals[] = {
        0,
        1,
        0x10000,
        0x10001,
#if defined(__x86_64__)
        0x100000000L,
        0x100000001L,
#endif
    };
    int i, res;

#if !defined(__x86_64__)
    TEST_LOOP("jcxz");
    TEST_LOOP("loopw");
    TEST_LOOP("loopzw");
    TEST_LOOP("loopnzw");
#endif

    TEST_LOOP("jecxz");
    TEST_LOOP("loopl");
    TEST_LOOP("loopzl");
    TEST_LOOP("loopnzl");
}

#undef CC_MASK
#ifdef TEST_P4_FLAGS
#define CC_MASK (CC_C | CC_P | CC_Z | CC_S | CC_O | CC_A)
#else
#define CC_MASK (CC_O | CC_C)
#endif

#define OP mul
#include "test-i386-muldiv.h"

#define OP imul
#include "test-i386-muldiv.h"

void test_imulw2(long op0, long op1)
{
    long res, s1, s0, flags;
    s0 = op0;
    s1 = op1;
    res = s0;
    flags = 0;
    asm volatile ("push %4\n\t"
         "popf\n\t"
         "imulw %w2, %w0\n\t"
         "pushf\n\t"
         "pop %1\n\t"
         : "=q" (res), "=g" (flags)
         : "q" (s1), "0" (res), "1" (flags));
    printf("%-10s A=" FMTLX " B=" FMTLX " R=" FMTLX " CC=%04lx\n",
           "imulw", s0, s1, res, flags & CC_MASK);
}

void test_imull2(long op0, long op1)
{
    long res, s1, s0, flags;
    s0 = op0;
    s1 = op1;
    res = s0;
    flags = 0;
    asm volatile ("push %4\n\t"
         "popf\n\t"
         "imull %k2, %k0\n\t"
         "pushf\n\t"
         "pop %1\n\t"
         : "=q" (res), "=g" (flags)
         : "q" (s1), "0" (res), "1" (flags));
    printf("%-10s A=" FMTLX " B=" FMTLX " R=" FMTLX " CC=%04lx\n",
           "imull", s0, s1, res, flags & CC_MASK);
}

#if defined(__x86_64__)
void test_imulq2(long op0, long op1)
{
    long res, s1, s0, flags;
    s0 = op0;
    s1 = op1;
    res = s0;
    flags = 0;
    asm volatile ("push %4\n\t"
         "popf\n\t"
         "imulq %2, %0\n\t"
         "pushf\n\t"
         "pop %1\n\t"
         : "=q" (res), "=g" (flags)
         : "q" (s1), "0" (res), "1" (flags));
    printf("%-10s A=" FMTLX " B=" FMTLX " R=" FMTLX " CC=%04lx\n",
           "imulq", s0, s1, res, flags & CC_MASK);
}
#endif

#define TEST_IMUL_IM(size, rsize, op0, op1)\
{\
    long res, flags, s1;\
    flags = 0;\
    res = 0;\
    s1 = op1;\
    asm volatile ("push %3\n\t"\
         "popf\n\t"\
         "imul" size " $" #op0 ", %" rsize "2, %" rsize "0\n\t" \
         "pushf\n\t"\
         "pop %1\n\t"\
         : "=r" (res), "=g" (flags)\
         : "r" (s1), "1" (flags), "0" (res));\
    printf("%-10s A=" FMTLX " B=" FMTLX " R=" FMTLX " CC=%04lx\n",\
           "imul" size " im", (long)op0, (long)op1, res, flags & CC_MASK);\
}


#undef CC_MASK
#define CC_MASK (0)

#define OP div
#include "test-i386-muldiv.h"

#define OP idiv
#include "test-i386-muldiv.h"

void test_mul(void)
{
    test_imulb(0x1234561d, 4);
    test_imulb(3, -4);
    test_imulb(0x80, 0x80);
    test_imulb(0x10, 0x10);

    test_imulw(0, 0x1234001d, 45);
    test_imulw(0, 23, -45);
    test_imulw(0, 0x8000, 0x8000);
    test_imulw(0, 0x100, 0x100);

    test_imull(0, 0x1234001d, 45);
    test_imull(0, 23, -45);
    test_imull(0, 0x80000000, 0x80000000);
    test_imull(0, 0x10000, 0x10000);

    test_mulb(0x1234561d, 4);
    test_mulb(3, -4);
    test_mulb(0x80, 0x80);
    test_mulb(0x10, 0x10);

    test_mulw(0, 0x1234001d, 45);
    test_mulw(0, 23, -45);
    test_mulw(0, 0x8000, 0x8000);
    test_mulw(0, 0x100, 0x100);

    test_mull(0, 0x1234001d, 45);
    test_mull(0, 23, -45);
    test_mull(0, 0x80000000, 0x80000000);
    test_mull(0, 0x10000, 0x10000);

    test_mull(0, 0xffffffff, 0xffffffff);
    test_mull(0, 0xfffffffe, 0xffffffff);
    test_mull(0, 0xffffffff, 0xfffffffe);

    test_mull(0, 0xffffffff, 0);
    test_mull(0, 0xffffffff, 1);
    test_mull(0, 0xffffffff, 2);
    test_mull(0, 0xffffffff, 3);

    test_mull(0, 0, 0xffffffff);
    test_mull(0, 1, 0xffffffff);
    test_mull(0, 2, 0xffffffff);
    test_mull(0, 3, 0xffffffff);


    test_imulw2(0x1234001d, 45);
    test_imulw2(23, -45);
    test_imulw2(0x8000, 0x8000);
    test_imulw2(0x100, 0x100);

    test_imull2(0x1234001d, 45);
    test_imull2(23, -45);
    test_imull2(0x80000000, 0x80000000);
    test_imull2(0x10000, 0x10000);

    TEST_IMUL_IM("w", "w", 45, 0x1234);
    TEST_IMUL_IM("w", "w", -45, 23);
    TEST_IMUL_IM("w", "w", 0x8000, 0x80000000);
    TEST_IMUL_IM("w", "w", 0x7fff, 0x1000);

    TEST_IMUL_IM("l", "k", 45, 0x1234);
    TEST_IMUL_IM("l", "k", -45, 23);
    TEST_IMUL_IM("l", "k", 0x8000, 0x80000000);
    TEST_IMUL_IM("l", "k", 0x7fff, 0x1000);

    test_idivb(0x12341678, 0x127e);
    test_idivb(0x43210123, -5);
    test_idivb(0x12340004, -1);
    test_idivb(-20, 3);
    test_idivb(20, -3);
    test_idivb(-20, -3);

    test_idivw(0, 0x12345678, 12347);
    test_idivw(0, -23223, -45);
    test_idivw(0, 0x12348000, -1);
    test_idivw(0x12343, 0x12345678, 0x81238567);
    test_idivw(-20, 0, 300);
    test_idivw(20,  0, -300);
    test_idivw(-20, 0, -300);

    test_idivl(0, 0x12345678, 12347);
    test_idivl(0, -233223, -45);
    test_idivl(0, 0x80000000, -1);
    test_idivl(0x12343, 0x12345678, 0x81234567);

    test_divb(0x12341678, 0x127e);
    test_divb(0x43210123, -5);
    test_divb(0x12340004, -1);

    test_divw(0, 0x12345678, 12347);
    test_divw(0, -23223, -45);
    test_divw(0, 0x12348000, -1);
    test_divw(0x12343, 0x12345678, 0x81238567);

    test_divl(0, 0x12345678, 12347);
    test_divl(0, -233223, -45);
    test_divl(0, 0x80000000, -1);
    test_divl(0x12343, 0x12345678, 0x81234567);

    test_divl(0xfffffffe, 0xffffffff, 0xffffffff);
    test_divl(0xffffffe, 0xffffffff, 0xfffffff);
    test_divl(0xfffffe, 0xffffffff, 0xffffff);
    test_divl(0xffffe, 0xffffffff, 0xfffff);
    test_divl(0xfffe, 0xffffffff, 0xffff);
    test_divl(0xffe, 0xffffffff, 0xfff);
    test_divl(0xfe, 0xffffffff, 0xff);
    test_divl(0xe, 0xffffffff, 0xf);

    test_divl(0x7ffffffe, 0xffffffff, 0x7fffffff);
    test_divl(0x7fffffe, 0xffffffff, 0x7ffffff);
    test_divl(0x7ffffe, 0xffffffff, 0x7fffff);
    test_divl(0x7fffe, 0xffffffff, 0x7ffff);
    test_divl(0x7ffe, 0xffffffff, 0x7fff);
    test_divl(0x7fe, 0xffffffff, 0x7ff);
    test_divl(0x7e, 0xffffffff, 0x7f);

    test_divl(0x3ffffffe, 0xffffffff, 0x3fffffff);
    test_divl(0x3fffffe, 0xffffffff, 0x3ffffff);
    test_divl(0x3ffffe, 0xffffffff, 0x3fffff);
    test_divl(0x3fffe, 0xffffffff, 0x3ffff);
    test_divl(0x3ffe, 0xffffffff, 0x3fff);
    test_divl(0x3fe, 0xffffffff, 0x3ff);
    test_divl(0x3e, 0xffffffff, 0x3f);

    test_divl(0x1ffffffe, 0xffffffff, 0x1fffffff);
    test_divl(0x1fffffe, 0xffffffff, 0x1ffffff);
    test_divl(0x1ffffe, 0xffffffff, 0x1fffff);
    test_divl(0x1fffe, 0xffffffff, 0x1ffff);
    test_divl(0x1ffe, 0xffffffff, 0x1fff);
    test_divl(0x1fe, 0xffffffff, 0x1ff);
    test_divl(0x1e, 0xffffffff, 0x1f);

    int i;
    for(i = 0; i < 16; i++)
    {
        test_divl(0, 0xfffffffe, i + 1);
        test_divl(0, 0xffffffff, i + 1);
        test_divl(1, 0xfffffffe, i + 2);
        test_divl(1, 0xffffffff, i + 2);
        test_divl(2, 0xfffffffe, i + 3);
        test_divl(2, 0xffffffff, i + 3);
        test_divl(3, 0xfffffffe, i + 4);
        test_divl(3, 0xffffffff, i + 4);
        test_divl(4, 0xfffffffe, i + 5);
        test_divl(4, 0xffffffff, i + 5);

        test_divl(0xfffffffd, 0x00000000 + i, 0xfffffffe);
        test_divl(0xfffffffd, 0xfffffff0 + i, 0xfffffffe);

        test_divl(0xfffffffe, 0x00000000 + i, 0xffffffff);
        test_divl(0xfffffffe, 0xfffffff0 + i, 0xffffffff);

        test_divl(0, i, 0xfffffffa);
        test_divl(0, i, 0xfffffffb);
        test_divl(0, i, 0xfffffffc);
        test_divl(0, i, 0xfffffffd);
        test_divl(0, i, 0xfffffffe);
        test_divl(0, i, 0xffffffff);

        test_idivl(0, 1,  i + 1);
        test_idivl(-1, -1, i + 1);
        test_idivl(0, 1,  -(i + 1));
        test_idivl(-1, -1, -(i + 1));

        test_idivl(0,  0x7fffffff, i + 1);
        test_idivl(-1, 0x80000001, i + 1);
        test_idivl(0,  0x7fffffff, -(i + 1));
        test_idivl(-1, 0x80000001, -(i + 1));
    }

#if defined(__x86_64__)
    test_imulq(0, 0x1234001d1234001d, 45);
    test_imulq(0, 23, -45);
    test_imulq(0, 0x8000000000000000, 0x8000000000000000);
    test_imulq(0, 0x100000000, 0x100000000);

    test_mulq(0, 0x1234001d1234001d, 45);
    test_mulq(0, 23, -45);
    test_mulq(0, 0x8000000000000000, 0x8000000000000000);
    test_mulq(0, 0x100000000, 0x100000000);

    test_imulq2(0x1234001d1234001d, 45);
    test_imulq2(23, -45);
    test_imulq2(0x8000000000000000, 0x8000000000000000);
    test_imulq2(0x100000000, 0x100000000);

    TEST_IMUL_IM("q", "", 45, 0x12341234);
    TEST_IMUL_IM("q", "", -45, 23);
    TEST_IMUL_IM("q", "", 0x8000, 0x8000000000000000);
    TEST_IMUL_IM("q", "", 0x7fff, 0x10000000);

    test_idivq(0, 0x12345678abcdef, 12347);
    test_idivq(0, -233223, -45);
    test_idivq(0, 0x8000000000000000, -1);
    test_idivq(0x12343, 0x12345678, 0x81234567);

    test_divq(0, 0x12345678abcdef, 12347);
    test_divq(0, -233223, -45);
    test_divq(0, 0x8000000000000000, -1);
    test_divq(0x12343, 0x12345678, 0x81234567);
#endif
}

#define TEST_BSX(op, size, op0)\
{\
    long res, val, resz;\
    val = op0;\
    asm("xor %1, %1\n"\
        "mov $0x12345678, %0\n"\
        #op " %" size "2, %" size "0 ; setz %b1" \
        : "=&r" (res), "=&q" (resz)\
        : "r" (val));\
    printf("%-10s A=" FMTLX " R=" FMTLX " %ld\n", #op, val, res, resz);\
}

void test_bsx(void)
{
    TEST_BSX(bsrw, "w", 0);
    TEST_BSX(bsrw, "w", 0x12340128);
    TEST_BSX(bsrw, "w", 0xffffffff);
    TEST_BSX(bsrw, "w", 0xffff7fff);

    TEST_BSX(bsfw, "w", 0);
    TEST_BSX(bsfw, "w", 0x12340128);
    TEST_BSX(bsfw, "w", 0xffffffff);
    TEST_BSX(bsfw, "w", 0xfffffff7);

    TEST_BSX(bsrl, "k", 0);
    TEST_BSX(bsrl, "k", 0x00340128);
    TEST_BSX(bsrl, "k", 0xffffffff);
    TEST_BSX(bsrl, "k", 0x7fffffff);

    TEST_BSX(bsfl, "k", 0);
    TEST_BSX(bsfl, "k", 0x00340128);
    TEST_BSX(bsfl, "k", 0xffffffff);
    TEST_BSX(bsfl, "k", 0xfffffff7);

#if defined(__x86_64__)
    TEST_BSX(bsrq, "", 0);
    TEST_BSX(bsrq, "", 0x003401281234);
    TEST_BSX(bsfq, "", 0);
    TEST_BSX(bsfq, "", 0x003401281234);
#endif
}

#define TEST_POPCNT(size, op0)\
{\
    long res, val, resz;\
    val = op0;\
    asm("xor %1, %1\n"\
        "mov $0x12345678, %0\n"\
        "popcnt %" size "2, %" size "0 ; pushf; pop %1;" \
        : "=&r" (res), "=&q" (resz)\
        : "r" (val));\
    printf("popcnt A=" FMTLX " R=" FMTLX " flags=%lx\n", val, res, resz);\
}

void test_popcnt(void)
{
    TEST_POPCNT("w", 0);
}

/**********************************************/

union float64u {
    double d;
    uint64_t l;
};

union float64u q_nan = { .l = 0xFFF8000000000000LL };
union float64u s_nan = { .l = 0xFFF0000000000000LL };

void test_fops(double a, double b)
{
    //int ib = (int)b;
    //int dest = 0;

    // XXX: Tests below are disabled since libc (which is statically linked)
    //      contains sse instructions, some of which aren't supported.

    printf("a=%f b=%f a+b=%f\n", a, b, a + b);
    printf("a=%f b=%f a-b=%f\n", a, b, a - b);
    printf("a=%f b=%f a*b=%f\n", a, b, a * b);
    printf("a=%f b=%f a/b=%f\n", a, b, a / b);
    printf("a=%f b=%f =%f\n", a, b, a + a + a + 3 * b / a * (a * a * a / b / b / (a + 1.0) - 3.5 + a * b / (3.7 * a / (a - b * b) + 6.5 * a / (b * b * a / -b - a * b) + 5.5 * (b - a))));
    printf("a=%f b=%f fmod(a, b)=%f\n", a, b, fmod(a, b));
    //printf("a=%f fma(a,b,a)=%f\n", a, fma(a, b, a));
    //printf("a=%f fdim(a,b)=%f\n", a, fdim(a, b));
    printf("a=%f copysign(a,b)=%f\n", a, copysign(a, b));
    printf("a=%f sqrt(a)=%f\n", a, sqrt(a));
    //printf("a=%f sin(a)=%f\n", a, sin(a));
    //printf("a=%f cos(a)=%f\n", a, cos(a));
    //printf("a=%f tan(a)=%f\n", a, tan(a));
    //printf("a=%f log(a)=%f\n", a, log(a));
    //printf("a=%f log10(a)=%f\n", a, log10(a));
    //printf("a=%f log1p(a)=%f\n", a, log1p(a));
    //printf("a=%f log2(a)=%f\n", a, log2(a));
    //printf("a=%f logb(a)=%f\n", a, logb(a));
    //printf("a=%f ilogb(a)=%d\n", a, ilogb(a));
    printf("a=%f exp(a)=%f\n", a, exp(a));
    //printf("a=%f exp2(a)=%f\n", a, exp2(a));
    //printf("a=%f frexp(a)=%f, %d\n", a, frexp(a, &dest), dest);
    //printf("a=%f ldexp(a,b)=%f\n", a, ldexp(a, ib));
    //printf("a=%f scalbn(a,b)=%f\n", a, scalbn(a, ib));
    //printf("a=%f sihh(a)=%f\n", a, sinh(a));
    //printf("a=%f cosh(a)=%f\n", a, cosh(a));
    //printf("a=%f tanh(a)=%f\n", a, tanh(a));
    //printf("a=%f fabs(a)=%f\n", a, fabs(a));
    //printf("a=%f pow(a,b)=%f\n", a, pow(a,b));
    //printf("a=%f b=%f atan2(a, b)=%f\n", a, b, atan2(a, b));
    ///* just to test some op combining */
    //printf("a=%f asin(sin(a))=%f\n", a, asin(sin(a)));
    //printf("a=%f acos(cos(a))=%f\n", a, acos(cos(a)));
    //printf("a=%f atan(tan(a))=%f\n", a, atan(tan(a)));

}

void fpu_clear_exceptions(void)
{
    struct QEMU_PACKED {
        uint16_t fpuc;
        uint16_t dummy1;
        uint16_t fpus;
        uint16_t dummy2;
        uint16_t fptag;
        uint16_t dummy3;
        uint32_t ignored[4];
        long double fpregs[8];
    } float_env32;

    asm volatile ("fnstenv %0\n" : "=m" (float_env32));
    float_env32.fpus &= ~0x7f;
    asm volatile ("fldenv %0\n" : : "m" (float_env32));
}

/* XXX: display exception bits when supported */
#define FPUS_EMASK 0x0000
//#define FPUS_EMASK 0x007f

void test_fcmp(double a, double b)
{
    long eflags, fpus;

    fpu_clear_exceptions();
    asm("fcom %2\n"
        "fstsw %%ax\n"
        : "=a" (fpus)
        : "t" (a), "u" (b));
    printf("fcom(%f %f)=%04lx\n",
           a, b, fpus & (0x4500 | FPUS_EMASK));
    fpu_clear_exceptions();
    asm("fucom %2\n"
        "fstsw %%ax\n"
        : "=a" (fpus)
        : "t" (a), "u" (b));
    printf("fucom(%f %f)=%04lx\n",
           a, b, fpus & (0x4500 | FPUS_EMASK));
    if (TEST_FCOMI) {
        /* test f(u)comi instruction */
        fpu_clear_exceptions();
        asm("fcomi %3, %2\n"
            "fstsw %%ax\n"
            "pushf\n"
            "pop %0\n"
            : "=r" (eflags), "=a" (fpus)
            : "t" (a), "u" (b));
        printf("fcomi(%f %f)=%04lx %02lx\n",
               a, b, fpus & FPUS_EMASK, eflags & (CC_Z | CC_P | CC_C));
        fpu_clear_exceptions();
        asm("fucomi %3, %2\n"
            "fstsw %%ax\n"
            "pushf\n"
            "pop %0\n"
            : "=r" (eflags), "=a" (fpus)
            : "t" (a), "u" (b));
        printf("fucomi(%f %f)=%04lx %02lx\n",
               a, b, fpus & FPUS_EMASK, eflags & (CC_Z | CC_P | CC_C));
    }
    fpu_clear_exceptions();
    asm volatile("fxam\n"
                 "fstsw %%ax\n"
                 : "=a" (fpus)
                 : "t" (a));
    printf("fxam(%f)=%04lx\n", a, fpus & 0x4700);
    fpu_clear_exceptions();
}

void test_fcvt(double a)
{
    float fa;
    long double la;
    int16_t fpuc;
    int i;
    int64_t lla;
    int ia;
    int16_t wa;
    double ra;

    fa = a;
    la = a;
    printf("(float)%f = %f\n", a, fa);
    printf("(long double)%f = %Lf\n", a, la);
    printf("a=" FMT64X "\n", *(uint64_t *)&a);
    printf("la=" FMT64X " %04x\n", *(uint64_t *)&la,
           *(unsigned short *)((char *)(&la) + 8));

    /* test all roundings */
    asm volatile ("fstcw %0" : "=m" (fpuc));
    for(i=0;i<4;i++) {
        uint16_t val16;
        val16 = (fpuc & ~0x0c00) | (i << 10);
        asm volatile ("fldcw %0" : : "m" (val16));
        asm volatile ("fist %0" : "=m" (wa) : "t" (a));
        asm volatile ("fistl %0" : "=m" (ia) : "t" (a));
        asm volatile ("fistpll %0" : "=m" (lla) : "t" (a) : "st");
        asm volatile ("frndint ; fstl %0" : "=m" (ra) : "t" (a));
        asm volatile ("fldcw %0" : : "m" (fpuc));
        printf("(short)a = %d\n", wa);
        printf("(int)a = %d\n", ia);
        printf("(int64_t)a = " FMT64X "\n", lla);
        printf("rint(a) = %f\n", ra);
    }
}

#define TEST(N) \
    asm("fld" #N : "=t" (a)); \
    printf("fld" #N "= %f\n", a);

void test_fconst(void)
{
    double a;
    TEST(1);
    TEST(l2t);
    TEST(l2e);
    TEST(pi);
    TEST(lg2);
    TEST(ln2);
    TEST(z);
}

void test_fbcd(double a)
{
    unsigned short bcd[5];
    double b;

    asm("fbstp %0" : "=m" (bcd[0]) : "t" (a) : "st");
    asm("fbld %1" : "=t" (b) : "m" (bcd[0]));
    printf("a=%f bcd=%04x%04x%04x%04x%04x b=%f\n",
           a, bcd[4], bcd[3], bcd[2], bcd[1], bcd[0], b);
}

#define TEST_ENV(env, save, restore)\
{\
    memset((env), 0xaa, sizeof(*(env)));\
    for(i=0;i<5;i++)\
        asm volatile ("fldl %0" : : "m" (dtab[i]));\
    asm volatile (save " %0\n" : : "m" (*(env)));\
    asm volatile (restore " %0\n": : "m" (*(env)));\
    for(i=0;i<5;i++)\
        asm volatile ("fstpl %0" : "=m" (rtab[i]));\
    for(i=0;i<5;i++)\
        printf("res[%d]=%f\n", i, rtab[i]);\
    printf("fpuc=%04x fpus=%04x fptag=%04x\n",\
           (env)->fpuc,\
           (env)->fpus & 0xff00,\
           (env)->fptag);\
}

void test_fenv(void)
{
    struct QEMU_PACKED {
        uint16_t fpuc;
        uint16_t dummy1;
        uint16_t fpus;
        uint16_t dummy2;
        uint16_t fptag;
        uint16_t dummy3;
        uint32_t ignored[4];
        long double fpregs[8];
    } float_env32;
    struct QEMU_PACKED {
        uint16_t fpuc;
        uint16_t fpus;
        uint16_t fptag;
        uint16_t ignored[4];
        long double fpregs[8];
    } float_env16;
    double dtab[8];
    double rtab[8];
    int i;

    for(i=0;i<8;i++)
        dtab[i] = i + 1;

    //TEST_ENV(&float_env16, "data16 fnstenv", "data16 fldenv");
    //TEST_ENV(&float_env16, "data16 fnsave", "data16 frstor");
    TEST_ENV(&float_env32, "fnstenv", "fldenv");
    TEST_ENV(&float_env32, "fnsave", "frstor");

    /* test for ffree */
    for(i=0;i<5;i++)
        asm volatile ("fldl %0" : : "m" (dtab[i]));
    asm volatile("ffree %st(2)");
    asm volatile ("fnstenv %0\n" : : "m" (float_env32));
    asm volatile ("fninit");
    printf("fptag=%04x\n", float_env32.fptag);
}


#define TEST_FCMOV(a, b, eflags, CC)\
{\
    double res;\
    asm("push %3\n"\
        "popf\n"\
        "fcmov" CC " %2, %0\n"\
        : "=t" (res)\
        : "0" (a), "u" (b), "g" (eflags));\
    printf("fcmov%s eflags=0x%04lx-> %f\n", \
           CC, (long)eflags, res);\
}

void test_fcmov(void)
{
    double a, b;
    long eflags, i;

    a = 1.0;
    b = 2.0;
    for(i = 0; i < 4; i++) {
        eflags = 0;
        if (i & 1)
            eflags |= CC_C;
        if (i & 2)
            eflags |= CC_Z;
        TEST_FCMOV(a, b, eflags, "b");
        TEST_FCMOV(a, b, eflags, "e");
        TEST_FCMOV(a, b, eflags, "be");
        TEST_FCMOV(a, b, eflags, "nb");
        TEST_FCMOV(a, b, eflags, "ne");
        TEST_FCMOV(a, b, eflags, "nbe");
    }
    TEST_FCMOV(a, b, 0, "u");
    TEST_FCMOV(a, b, CC_P, "u");
    TEST_FCMOV(a, b, 0, "nu");
    TEST_FCMOV(a, b, CC_P, "nu");
}

void test_floats(void)
{
    test_fops(2, 3);
    test_fops(1.4, -5);
    test_fops(-20.5, 128);
    test_fops(-0.5, -4);
    test_fcmp(2, -1);
    test_fcmp(2, 2);
    test_fcmp(2, 3);
    test_fcmp(2, q_nan.d);
    test_fcmp(q_nan.d, -1);
    test_fcmp(-1.0/0.0, -1);
    test_fcmp(1.0/0.0, -1);
    test_fcvt(0.5);
    test_fcvt(-0.5);
    test_fcvt(1.0/7.0);
    test_fcvt(-1.0/9.0);
    test_fcvt(32768);
    test_fcvt(-1e20);
    test_fcvt(-1.0/0.0);
    test_fcvt(1.0/0.0);
    test_fcvt(q_nan.d);
    test_fconst();
    //test_fbcd(1234567890123456.0);
    //test_fbcd(-123451234567890.0);
    test_fenv();
    if (TEST_CMOV) {
        test_fcmov();
    }
}

/**********************************************/
#if !defined(__x86_64__)

#define TEST_BCD(op, op0, cc_in, cc_mask)\
{\
    int res, flags;\
    res = op0;\
    flags = cc_in;\
    asm ("push %3\n\t"\
         "popf\n\t"\
         #op "\n\t"\
         "pushf\n\t"\
         "pop %1\n\t"\
        : "=a" (res), "=g" (flags)\
        : "0" (res), "1" (flags));\
    printf("%-10s A=%08x R=%08x CCIN=%04x CC=%04x\n",\
           #op, op0, res, cc_in, flags & cc_mask);\
}

void test_bcd(void)
{
    TEST_BCD(daa, 0x12340503, CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(daa, 0x12340506, CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(daa, 0x12340507, CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(daa, 0x12340559, CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(daa, 0x12340560, CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(daa, 0x1234059f, CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(daa, 0x123405a0, CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(daa, 0x12340503, 0, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(daa, 0x12340506, 0, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(daa, 0x12340503, CC_C, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(daa, 0x12340506, CC_C, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(daa, 0x12340503, CC_C | CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(daa, 0x12340506, CC_C | CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_A));

    TEST_BCD(das, 0x12340503, CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(das, 0x12340506, CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(das, 0x12340507, CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(das, 0x12340559, CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(das, 0x12340560, CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(das, 0x1234059f, CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(das, 0x123405a0, CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(das, 0x12340503, 0, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(das, 0x12340506, 0, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(das, 0x12340503, CC_C, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(das, 0x12340506, CC_C, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(das, 0x12340503, CC_C | CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_A));
    TEST_BCD(das, 0x12340506, CC_C | CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_A));

    TEST_BCD(aaa, 0x12340205, CC_A, (CC_C | CC_A));
    TEST_BCD(aaa, 0x12340306, CC_A, (CC_C | CC_A));
    TEST_BCD(aaa, 0x1234040a, CC_A, (CC_C | CC_A));
    TEST_BCD(aaa, 0x123405fa, CC_A, (CC_C | CC_A));
    TEST_BCD(aaa, 0x12340205, 0, (CC_C | CC_A));
    TEST_BCD(aaa, 0x12340306, 0, (CC_C | CC_A));
    TEST_BCD(aaa, 0x1234040a, 0, (CC_C | CC_A));
    TEST_BCD(aaa, 0x123405fa, 0, (CC_C | CC_A));

    TEST_BCD(aas, 0x12340205, CC_A, (CC_C | CC_A));
    TEST_BCD(aas, 0x12340306, CC_A, (CC_C | CC_A));
    TEST_BCD(aas, 0x1234040a, CC_A, (CC_C | CC_A));
    TEST_BCD(aas, 0x123405fa, CC_A, (CC_C | CC_A));
    TEST_BCD(aas, 0x12340205, 0, (CC_C | CC_A));
    TEST_BCD(aas, 0x12340306, 0, (CC_C | CC_A));
    TEST_BCD(aas, 0x1234040a, 0, (CC_C | CC_A));
    TEST_BCD(aas, 0x123405fa, 0, (CC_C | CC_A));

    TEST_BCD(aam, 0x12340547, CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_O | CC_A));
    TEST_BCD(aad, 0x12340407, CC_A, (CC_C | CC_P | CC_Z | CC_S | CC_O | CC_A));
}
#endif

#define TEST_XCHG(op, size, opconst)\
{\
    long op0, op1;\
    op0 = i2l(0x12345678);\
    op1 = i2l(0xfbca7654);\
    asm(#op " %" size "0, %" size "1" \
        : "=q" (op0), opconst (op1) \
        : "0" (op0));\
    printf("%-10s A=" FMTLX " B=" FMTLX "\n",\
           #op, op0, op1);\
}

#define TEST_CMPXCHG(op, size, opconst, eax)\
{\
    long op0, op1, op2;\
    long eflags;\
    op0 = i2l(0x12345678);\
    op1 = i2l(0xfbca7654);\
    op2 = i2l(eax);\
    asm(#op " %" size "0, %" size "1\n" \
        "pushf\n" \
        "pop %2\n" \
        : "=q" (op0), opconst (op1), "=g" (eflags) \
        : "0" (op0), "a" (op2));\
    printf("%-10s EAX=" FMTLX " A=" FMTLX " C=" FMTLX " CC=%02lx\n",\
           #op, op2, op0, op1, eflags & (CC_C | CC_P | CC_Z | CC_S | CC_O | CC_A));\
}

void test_xchg(void)
{
#if defined(__x86_64__)
    TEST_XCHG(xchgq, "", "+q");
#endif
    TEST_XCHG(xchgl, "k", "+q");
    TEST_XCHG(xchgw, "w", "+q");
    TEST_XCHG(xchgb, "b", "+q");

#if defined(__x86_64__)
    TEST_XCHG(xchgq, "", "=m");
#endif
    TEST_XCHG(xchgl, "k", "+m");
    TEST_XCHG(xchgw, "w", "+m");
    TEST_XCHG(xchgb, "b", "+m");

#if defined(__x86_64__)
    TEST_XCHG(xaddq, "", "+q");
#endif
    TEST_XCHG(xaddl, "k", "+q");
    TEST_XCHG(xaddw, "w", "+q");
    TEST_XCHG(xaddb, "b", "+q");

    {
        int res;
        res = 0x12345678;
        asm("xaddl %1, %0" : "=r" (res) : "0" (res));
        printf("xaddl same res=%08x\n", res);
    }

#if defined(__x86_64__)
    TEST_XCHG(xaddq, "", "+m");
#endif
    TEST_XCHG(xaddl, "k", "+m");
    TEST_XCHG(xaddw, "w", "+m");
    TEST_XCHG(xaddb, "b", "+m");

#if defined(__x86_64__)
    TEST_CMPXCHG(cmpxchgq, "", "+q", 0xfbca7654);
#endif
    TEST_CMPXCHG(cmpxchgl, "k", "+q", 0xfbca7654);
    TEST_CMPXCHG(cmpxchgw, "w", "+q", 0xfbca7654);
    TEST_CMPXCHG(cmpxchgb, "b", "+q", 0xfbca7654);

#if defined(__x86_64__)
    TEST_CMPXCHG(cmpxchgq, "", "+q", 0xfffefdfc);
#endif
    TEST_CMPXCHG(cmpxchgl, "k", "+q", 0xfffefdfc);
    TEST_CMPXCHG(cmpxchgw, "w", "+q", 0xfffefdfc);
    TEST_CMPXCHG(cmpxchgb, "b", "+q", 0xfffefdfc);

#if defined(__x86_64__)
    TEST_CMPXCHG(cmpxchgq, "", "+m", 0xfbca7654);
#endif
    TEST_CMPXCHG(cmpxchgl, "k", "+m", 0xfbca7654);
    TEST_CMPXCHG(cmpxchgw, "w", "+m", 0xfbca7654);
    TEST_CMPXCHG(cmpxchgb, "b", "+m", 0xfbca7654);

#if defined(__x86_64__)
    TEST_CMPXCHG(cmpxchgq, "", "+m", 0xfffefdfc);
#endif
    TEST_CMPXCHG(cmpxchgl, "k", "+m", 0xfffefdfc);
    TEST_CMPXCHG(cmpxchgw, "w", "+m", 0xfffefdfc);
    TEST_CMPXCHG(cmpxchgb, "b", "+m", 0xfffefdfc);

    {
        uint64_t op0, op1, op2;
        long eax, edx;
        long i, eflags;

        for(i = 0; i < 2; i++) {
            op0 = 0x123456789abcdLL;
            eax = i2l(op0 & 0xffffffff);
            edx = i2l(op0 >> 32);
            if (i == 0)
                op1 = 0xfbca765423456LL;
            else
                op1 = op0;
            op2 = 0x6532432432434LL;
            asm("cmpxchg8b %2\n"
                "pushf\n"
                "pop %3\n"
                : "=a" (eax), "=d" (edx), "=m" (op1), "=g" (eflags)
                : "0" (eax), "1" (edx), "m" (op1), "b" ((int)op2), "c" ((int)(op2 >> 32)));
            printf("cmpxchg8b: eax=" FMTLX " edx=" FMTLX " op1=" FMT64X " CC=%02lx\n",
                   eax, edx, op1, eflags & CC_Z);
        }
    }
}

#ifdef TEST_SEGS
/**********************************************/
/* segmentation tests */

#include <sys/syscall.h>
#include <unistd.h>
#include <asm/ldt.h>
#include <linux/version.h>

static inline int modify_ldt(int func, void * ptr, unsigned long bytecount)
{
    return syscall(__NR_modify_ldt, func, ptr, bytecount);
}

#if LINUX_VERSION_CODE >= KERNEL_VERSION(2, 5, 66)
#define modify_ldt_ldt_s user_desc
#endif

#define MK_SEL(n) (((n) << 3) | 7)

uint8_t seg_data1[4096];
uint8_t seg_data2[4096];

#define TEST_LR(op, size, seg, mask)\
{\
    int res, res2;\
    uint16_t mseg = seg;\
    res = 0x12345678;\
    asm (op " %" size "2, %" size "0\n" \
         "movl $0, %1\n"\
         "jnz 1f\n"\
         "movl $1, %1\n"\
         "1:\n"\
         : "=r" (res), "=r" (res2) : "m" (mseg), "0" (res));\
    printf(op ": Z=%d %08x\n", res2, res & ~(mask));\
}

#define TEST_ARPL(op, size, op1, op2)\
{\
    long a, b, c;                               \
    a = (op1);                                  \
    b = (op2);                                  \
    asm volatile(op " %" size "3, %" size "0\n"\
                 "movl $0,%1\n"\
                 "jnz 1f\n"\
                 "movl $1,%1\n"\
                 "1:\n"\
                 : "=r" (a), "=r" (c) : "0" (a), "r" (b));    \
    printf(op size " A=" FMTLX " B=" FMTLX " R=" FMTLX " z=%ld\n",\
           (long)(op1), (long)(op2), a, c);\
}

/* NOTE: we use Linux modify_ldt syscall */
void test_segs(void)
{
    struct modify_ldt_ldt_s ldt;
    long long ldt_table[3];
    int res, res2;
    char tmp;
    struct {
        uint32_t offset;
        uint16_t seg;
    } QEMU_PACKED segoff;

    ldt.entry_number = 1;
    ldt.base_addr = (unsigned long)&seg_data1;
    ldt.limit = (sizeof(seg_data1) + 0xfff) >> 12;
    ldt.seg_32bit = 1;
    ldt.contents = MODIFY_LDT_CONTENTS_DATA;
    ldt.read_exec_only = 0;
    ldt.limit_in_pages = 1;
    ldt.seg_not_present = 0;
    ldt.useable = 1;
    modify_ldt(1, &ldt, sizeof(ldt)); /* write ldt entry */

    ldt.entry_number = 2;
    ldt.base_addr = (unsigned long)&seg_data2;
    ldt.limit = (sizeof(seg_data2) + 0xfff) >> 12;
    ldt.seg_32bit = 1;
    ldt.contents = MODIFY_LDT_CONTENTS_DATA;
    ldt.read_exec_only = 0;
    ldt.limit_in_pages = 1;
    ldt.seg_not_present = 0;
    ldt.useable = 1;
    modify_ldt(1, &ldt, sizeof(ldt)); /* write ldt entry */

    modify_ldt(0, &ldt_table, sizeof(ldt_table)); /* read ldt entries */
    {
        int i;
        for(i=0;i<3;i++)
            printf("%d: %016Lx\n", i, ldt_table[i]);
    }
    /* do some tests with fs or gs */
    asm volatile ("movl %0, %%fs" : : "r" (MK_SEL(1)));

    seg_data1[1] = 0xaa;
    seg_data2[1] = 0x55;

    asm volatile ("fs movzbl 0x1, %0" : "=r" (res));
    printf("FS[1] = %02x\n", res);

    asm volatile ("pushl %%gs\n"
                  "movl %1, %%gs\n"
                  "gs movzbl 0x1, %0\n"
                  "popl %%gs\n"
                  : "=r" (res)
                  : "r" (MK_SEL(2)));
    printf("GS[1] = %02x\n", res);

    /* tests with ds/ss (implicit segment case) */
    tmp = 0xa5;
    asm volatile ("pushl %%ebp\n\t"
                  "pushl %%ds\n\t"
                  "movl %2, %%ds\n\t"
                  "movl %3, %%ebp\n\t"
                  "movzbl 0x1, %0\n\t"
                  "movzbl (%%ebp), %1\n\t"
                  "popl %%ds\n\t"
                  "popl %%ebp\n\t"
                  : "=r" (res), "=r" (res2)
                  : "r" (MK_SEL(1)), "r" (&tmp));
    printf("DS[1] = %02x\n", res);
    printf("SS[tmp] = %02x\n", res2);

    segoff.seg = MK_SEL(2);
    segoff.offset = 0xabcdef12;
    asm volatile("lfs %2, %0\n\t"
                 "movl %%fs, %1\n\t"
                 : "=r" (res), "=g" (res2)
                 : "m" (segoff));
    printf("FS:reg = %04x:%08x\n", res2, res);

    TEST_LR("larw", "w", MK_SEL(2), 0x0100);
    TEST_LR("larl", "", MK_SEL(2), 0x0100);
    TEST_LR("lslw", "w", MK_SEL(2), 0);
    TEST_LR("lsll", "", MK_SEL(2), 0);

    TEST_LR("larw", "w", 0xfff8, 0);
    TEST_LR("larl", "", 0xfff8, 0);
    TEST_LR("lslw", "w", 0xfff8, 0);
    TEST_LR("lsll", "", 0xfff8, 0);

    TEST_ARPL("arpl", "w", 0x12345678 | 3, 0x762123c | 1);
    TEST_ARPL("arpl", "w", 0x12345678 | 1, 0x762123c | 3);
    TEST_ARPL("arpl", "w", 0x12345678 | 1, 0x762123c | 1);
}

/* 16 bit code test */
extern char code16_start, code16_end;
extern char code16_func1;
extern char code16_func2;
extern char code16_func3;

void test_code16(void)
{
    struct modify_ldt_ldt_s ldt;
    int res, res2;

    /* build a code segment */
    ldt.entry_number = 1;
    ldt.base_addr = (unsigned long)&code16_start;
    ldt.limit = &code16_end - &code16_start;
    ldt.seg_32bit = 0;
    ldt.contents = MODIFY_LDT_CONTENTS_CODE;
    ldt.read_exec_only = 0;
    ldt.limit_in_pages = 0;
    ldt.seg_not_present = 0;
    ldt.useable = 1;
    modify_ldt(1, &ldt, sizeof(ldt)); /* write ldt entry */

    /* call the first function */
    asm volatile ("lcall %1, %2"
                  : "=a" (res)
                  : "i" (MK_SEL(1)), "i" (&code16_func1): "memory", "cc");
    printf("func1() = 0x%08x\n", res);
    asm volatile ("lcall %2, %3"
                  : "=a" (res), "=c" (res2)
                  : "i" (MK_SEL(1)), "i" (&code16_func2): "memory", "cc");
    printf("func2() = 0x%08x spdec=%d\n", res, res2);
    asm volatile ("lcall %1, %2"
                  : "=a" (res)
                  : "i" (MK_SEL(1)), "i" (&code16_func3): "memory", "cc");
    printf("func3() = 0x%08x\n", res);
}
#endif

#if defined(__x86_64__)
asm(".globl func_lret\n"
    "func_lret:\n"
    "movl $0x87654641, %eax\n"
    "lretq\n");
#else
asm(".globl func_lret\n"
    "func_lret:\n"
    "movl $0x87654321, %eax\n"
    "lret\n"

    ".globl func_iret\n"
    "func_iret:\n"
    "movl $0xabcd4321, %eax\n"
    "iret\n");
#endif

extern char func_lret;
extern char func_iret;

void test_misc(void)
{
    char table[256];
    long res, i;

    for(i=0;i<256;i++) table[i] = 256 - i;
    res = 0x12345678;
    asm ("xlat" : "=a" (res) : "b" (table), "0" (res));
    printf("xlat: EAX=" FMTLX "\n", res);

#if defined(__x86_64__)
#if 0
    {
        /* XXX: see if Intel Core2 and AMD64 behavior really
           differ. Here we implemented the Intel way which is not
           compatible yet with QEMU. */
        static struct QEMU_PACKED {
            uint64_t offset;
            uint16_t seg;
        } desc;
        long cs_sel;

        asm volatile ("mov %%cs, %0" : "=r" (cs_sel));

        asm volatile ("push %1\n"
                      "call func_lret\n"
                      : "=a" (res)
                      : "r" (cs_sel) : "memory", "cc");
        printf("func_lret=" FMTLX "\n", res);

        desc.offset = (long)&func_lret;
        desc.seg = cs_sel;

        asm volatile ("xor %%rax, %%rax\n"
                      "rex64 lcall *(%%rcx)\n"
                      : "=a" (res)
                      : "c" (&desc)
                      : "memory", "cc");
        printf("func_lret2=" FMTLX "\n", res);

        asm volatile ("push %2\n"
                      "mov $ 1f, %%rax\n"
                      "push %%rax\n"
                      "rex64 ljmp *(%%rcx)\n"
                      "1:\n"
                      : "=a" (res)
                      : "c" (&desc), "b" (cs_sel)
                      : "memory", "cc");
        printf("func_lret3=" FMTLX "\n", res);
    }
#endif
#else
    asm volatile ("push %%cs ; call %1"
                  : "=a" (res)
                  : "m" (func_lret): "memory", "cc");
    printf("func_lret=" FMTLX "\n", res);

    asm volatile ("pushf ; push %%cs ; call %1"
                  : "=a" (res)
                  : "m" (func_iret): "memory", "cc");
    printf("func_iret=" FMTLX "\n", res);
#endif

#if defined(__x86_64__)
    /* specific popl test */
    asm volatile ("push $12345432 ; push $0x9abcdef ; pop (%%rsp) ; pop %0"
                  : "=g" (res));
    printf("popl esp=" FMTLX "\n", res);
#else
    /* specific popl test */
    asm volatile ("pushl $12345432 ; pushl $0x9abcdef ; popl (%%esp) ; popl %0"
                  : "=g" (res));
    printf("popl esp=" FMTLX "\n", res);

    /* specific popw test */
    asm volatile ("pushl $12345432 ; pushl $0x9abcdef ; popw (%%esp) ; addl $2, %%esp ; popl %0"
                  : "=g" (res));
    printf("popw esp=" FMTLX "\n", res);
#endif
}

uint8_t str_buffer[4096];

#define TEST_STRING1(OP, size, DF, REP)\
{\
    long esi, edi, eax, ecx, eflags;\
\
    esi = (long)(str_buffer + sizeof(str_buffer) / 2);\
    edi = (long)(str_buffer + sizeof(str_buffer) / 2) + 16;\
    eax = i2l(0x12345678);\
    ecx = 17;\
\
    asm volatile ("push $0\n\t"\
                  "popf\n\t"\
                  DF "\n\t"\
                  REP #OP size "\n\t"\
                  "cld\n\t"\
                  "pushf\n\t"\
                  "pop %4\n\t"\
                  : "=S" (esi), "=D" (edi), "=a" (eax), "=c" (ecx), "=g" (eflags)\
                  : "0" (esi), "1" (edi), "2" (eax), "3" (ecx));\
    printf("%-10s ESI=" FMTLX " EDI=" FMTLX " EAX=" FMTLX " ECX=" FMTLX " EFL=%04x\n",\
           REP #OP size, esi, edi, eax, ecx,\
           (int)(eflags & (CC_C | CC_P | CC_Z | CC_S | CC_O | CC_A)));\
}

#define TEST_STRING(OP, REP)\
    TEST_STRING1(OP, "b", "", REP);\
    TEST_STRING1(OP, "w", "", REP);\
    TEST_STRING1(OP, "l", "", REP);\
    X86_64_ONLY(TEST_STRING1(OP, "q", "", REP));\
    TEST_STRING1(OP, "b", "std", REP);\
    TEST_STRING1(OP, "w", "std", REP);\
    TEST_STRING1(OP, "l", "std", REP);\
    X86_64_ONLY(TEST_STRING1(OP, "q", "std", REP))

void test_string(void)
{
    int i;
    for(i = 0;i < sizeof(str_buffer); i++)
        str_buffer[i] = i + 0x56;
   TEST_STRING(stos, "");
   TEST_STRING(stos, "rep ");
   TEST_STRING(lods, ""); /* to verify stos */
   TEST_STRING(lods, "rep ");
   TEST_STRING(movs, "");
   TEST_STRING(movs, "rep ");
   TEST_STRING(lods, ""); /* to verify stos */

   /* XXX: better tests */
   TEST_STRING(scas, "");
   TEST_STRING(scas, "repz ");
   TEST_STRING(scas, "repnz ");
   TEST_STRING(cmps, "");
   TEST_STRING(cmps, "repz ");
   TEST_STRING(cmps, "repnz ");
}

#ifdef TEST_VM86
/* VM86 test */

static inline void set_bit(uint8_t *a, unsigned int bit)
{
    a[bit / 8] |= (1 << (bit % 8));
}

static inline uint8_t *seg_to_linear(unsigned int seg, unsigned int reg)
{
    return (uint8_t *)((seg << 4) + (reg & 0xffff));
}

static inline void pushw(struct vm86_regs *r, int val)
{
    r->esp = (r->esp & ~0xffff) | ((r->esp - 2) & 0xffff);
    *(uint16_t *)seg_to_linear(r->ss, r->esp) = val;
}

static inline int vm86(int func, struct vm86plus_struct *v86)
{
    return syscall(__NR_vm86, func, v86);
}

extern char vm86_code_start;
extern char vm86_code_end;

#define VM86_CODE_CS 0x100
#define VM86_CODE_IP 0x100

void test_vm86(void)
{
    struct vm86plus_struct ctx;
    struct vm86_regs *r;
    uint8_t *vm86_mem;
    int seg, ret;

    vm86_mem = mmap((void *)0x00000000, 0x110000,
                    PROT_WRITE | PROT_READ | PROT_EXEC,
                    MAP_FIXED | MAP_ANON | MAP_PRIVATE, -1, 0);
    if (vm86_mem == MAP_FAILED) {
        printf("ERROR: could not map vm86 memory");
        return;
    }
    memset(&ctx, 0, sizeof(ctx));

    /* init basic registers */
    r = &ctx.regs;
    r->eip = VM86_CODE_IP;
    r->esp = 0xfffe;
    seg = VM86_CODE_CS;
    r->cs = seg;
    r->ss = seg;
    r->ds = seg;
    r->es = seg;
    r->fs = seg;
    r->gs = seg;
    //r->eflags = VIF_MASK;

    /* move code to proper address. We use the same layout as a .com
       dos program. */
    memcpy(vm86_mem + (VM86_CODE_CS << 4) + VM86_CODE_IP,
           &vm86_code_start, &vm86_code_end - &vm86_code_start);

    /* mark int 0x21 as being emulated */
    set_bit((uint8_t *)&ctx.int_revectored, 0x21);

    for(;;) {
        ret = vm86(VM86_ENTER, &ctx);
        switch(VM86_TYPE(ret)) {
        case VM86_INTx:
            {
                int int_num, ah, v;

                int_num = VM86_ARG(ret);
                if (int_num != 0x21)
                    goto unknown_int;
                ah = (r->eax >> 8) & 0xff;
                switch(ah) {
                case 0x00: /* exit */
                    goto the_end;
                case 0x02: /* write char */
                    {
                        uint8_t c = r->edx;
                        putchar(c);
                    }
                    break;
                case 0x09: /* write string */
                    {
                        uint8_t c, *ptr;
                        ptr = seg_to_linear(r->ds, r->edx);
                        for(;;) {
                            c = *ptr++;
                            if (c == '$')
                                break;
                            putchar(c);
                        }
                        r->eax = (r->eax & ~0xff) | '$';
                    }
                    break;
                case 0xff: /* extension: write eflags number in edx */
                    v = (int)r->edx;
#ifndef LINUX_VM86_IOPL_FIX
                    v &= ~0x3000;
#endif
                    printf("%08x\n", v);
                    break;
                default:
                unknown_int:
                    printf("unsupported int 0x%02x\n", int_num);
                    goto the_end;
                }
            }
            break;
        case VM86_SIGNAL:
            /* a signal came, we just ignore that */
            break;
        case VM86_STI:
            break;
        default:
            printf("ERROR: unhandled vm86 return code (0x%x)\n", ret);
            goto the_end;
        }
    }
 the_end:
    printf("VM86 end\n");
    munmap(vm86_mem, 0x110000);
}
#endif

/* exception tests */
#if defined(__i386__) && !defined(REG_EAX)
#define REG_EAX EAX
#define REG_EBX EBX
#define REG_ECX ECX
#define REG_EDX EDX
#define REG_ESI ESI
#define REG_EDI EDI
#define REG_EBP EBP
#define REG_ESP ESP
#define REG_EIP EIP
#define REG_EFL EFL
#define REG_TRAPNO TRAPNO
#define REG_ERR ERR
#endif

#if defined(__x86_64__)
#define REG_EIP REG_RIP
#endif

jmp_buf jmp_env;
int v1;
int tab[2];

void sig_handler(int sig, siginfo_t *info, void *puc)
{
    struct ucontext *uc = puc;

    printf("si_signo=%d si_errno=%d si_code=%d",
           info->si_signo, info->si_errno, info->si_code);
    printf(" si_addr=0x%08lx",
           (unsigned long)info->si_addr);
    printf("\n");

    printf("trapno=" FMTLX " err=" FMTLX,
           (long)uc->uc_mcontext.gregs[REG_TRAPNO],
           (long)uc->uc_mcontext.gregs[REG_ERR]);
    printf(" EIP=" FMTLX, (long)uc->uc_mcontext.gregs[REG_EIP]);
    printf("\n");
    longjmp(jmp_env, 1);
}

void test_exceptions(void)
{
    struct sigaction act;
    volatile int val;

    act.sa_sigaction = sig_handler;
    sigemptyset(&act.sa_mask);
    act.sa_flags = SA_SIGINFO | SA_NODEFER;
    sigaction(SIGFPE, &act, NULL);
    sigaction(SIGILL, &act, NULL);
    sigaction(SIGSEGV, &act, NULL);
    sigaction(SIGBUS, &act, NULL);
    sigaction(SIGTRAP, &act, NULL);

    /* test division by zero reporting */
    printf("DIVZ exception:\n");
    if (setjmp(jmp_env) == 0) {
        /* now divide by zero */
        v1 = 0;
        v1 = 2 / v1;
    }

#if 0
#if !defined(__x86_64__)
    printf("BOUND exception:\n");
    if (setjmp(jmp_env) == 0) {
        /* bound exception */
        tab[0] = 1;
        tab[1] = 10;
        asm volatile ("bound %0, %1" : : "r" (11), "m" (tab[0]));
    }
#endif
#endif

#ifdef TEST_SEGS
    printf("segment exceptions:\n");
    if (setjmp(jmp_env) == 0) {
        /* load an invalid segment */
        asm volatile ("movl %0, %%fs" : : "r" ((0x1234 << 3) | 1));
    }
    if (setjmp(jmp_env) == 0) {
        /* null data segment is valid */
        asm volatile ("movl %0, %%fs" : : "r" (3));
        /* null stack segment */
        asm volatile ("movl %0, %%ss" : : "r" (3));
    }

    {
        struct modify_ldt_ldt_s ldt;
        ldt.entry_number = 1;
        ldt.base_addr = (unsigned long)&seg_data1;
        ldt.limit = (sizeof(seg_data1) + 0xfff) >> 12;
        ldt.seg_32bit = 1;
        ldt.contents = MODIFY_LDT_CONTENTS_DATA;
        ldt.read_exec_only = 0;
        ldt.limit_in_pages = 1;
        ldt.seg_not_present = 1;
        ldt.useable = 1;
        modify_ldt(1, &ldt, sizeof(ldt)); /* write ldt entry */

        if (setjmp(jmp_env) == 0) {
            /* segment not present */
            asm volatile ("movl %0, %%fs" : : "r" (MK_SEL(1)));
        }
    }
#endif

    /* test SEGV reporting */
    printf("PF exception:\n");
    if (setjmp(jmp_env) == 0) {
        val = 1;
        /* we add a nop to test a weird PC retrieval case */
        asm volatile ("nop");
        /* now store in an invalid address */
        *(char *)0x1234 = 1;
    }

    /* test SEGV reporting */
    printf("PF exception:\n");
    if (setjmp(jmp_env) == 0) {
        val = 1;
        /* read from an invalid address */
        v1 = *(char *)0x1234;
    }

    /* test illegal instruction reporting */
    printf("UD2 exception:\n");
    if (setjmp(jmp_env) == 0) {
        /* now execute an invalid instruction */
        asm volatile("ud2");
    }
#if 0
    printf("lock nop exception:\n");
    if (setjmp(jmp_env) == 0) {
        /* now execute an invalid instruction */
        asm volatile(".byte 0xf0, 0x90"); /* lock nop */
    }
#endif

    printf("INT exception:\n");
    if (setjmp(jmp_env) == 0) {
        asm volatile ("int $0xfd");
    }
    if (setjmp(jmp_env) == 0) {
        asm volatile ("int $0x01");
    }
    if (setjmp(jmp_env) == 0) {
        asm volatile (".byte 0xcd, 0x03");
    }
    if (setjmp(jmp_env) == 0) {
        asm volatile ("int $0x04");
    }
    if (setjmp(jmp_env) == 0) {
        asm volatile ("int $0x05");
    }

    printf("INT3 exception:\n");
    if (setjmp(jmp_env) == 0) {
        asm volatile ("int3");
    }

    printf("CLI exception:\n");
    if (setjmp(jmp_env) == 0) {
        asm volatile ("cli");
    }

    printf("STI exception:\n");
    if (setjmp(jmp_env) == 0) {
        asm volatile ("cli");
    }

#if !defined(__x86_64__)
    printf("INTO exception:\n");
    if (setjmp(jmp_env) == 0) {
        /* overflow exception */
        asm volatile ("addl $1, %0 ; into" : : "r" (0x7fffffff));
    }
#endif

    printf("OUTB exception:\n");
    if (setjmp(jmp_env) == 0) {
        asm volatile ("outb %%al, %%dx" : : "d" (0x4321), "a" (0));
    }

    printf("INB exception:\n");
    if (setjmp(jmp_env) == 0) {
        asm volatile ("inb %%dx, %%al" : "=a" (val) : "d" (0x4321));
    }

    printf("REP OUTSB exception:\n");
    if (setjmp(jmp_env) == 0) {
        asm volatile ("rep outsb" : : "d" (0x4321), "S" (tab), "c" (1));
    }

    printf("REP INSB exception:\n");
    if (setjmp(jmp_env) == 0) {
        asm volatile ("rep insb" : : "d" (0x4321), "D" (tab), "c" (1));
    }

    printf("HLT exception:\n");
    if (setjmp(jmp_env) == 0) {
        asm volatile ("hlt");
    }

#if 0
    printf("single step exception:\n");
    val = 0;
    if (setjmp(jmp_env) == 0) {
        asm volatile ("pushf\n"
                      "orl $0x00100, (%%esp)\n"
                      "popf\n"
                      "movl $0xabcd, %0\n"
                      "movl $0x0, %0\n" : "=m" (val) : : "cc", "memory");
    }
    printf("val=0x%x\n", val);
#endif
}


#if !defined(__x86_64__)
/* specific precise single step test */
void sig_trap_handler(int sig, siginfo_t *info, void *puc)
{
    struct ucontext *uc = puc;
    printf("EIP=" FMTLX "\n", (long)uc->uc_mcontext.gregs[REG_EIP]);
}

const uint8_t sstep_buf1[4] = { 1, 2, 3, 4};
uint8_t sstep_buf2[4];

void test_single_step(void)
{
    struct sigaction act;
    volatile int val;
    int i;

    val = 0;
    act.sa_sigaction = sig_trap_handler;
    sigemptyset(&act.sa_mask);
    act.sa_flags = SA_SIGINFO;
    sigaction(SIGTRAP, &act, NULL);
    asm volatile ("pushf\n"
                  "orl $0x00100, (%%esp)\n"
                  "popf\n"
                  "movl $0xabcd, %0\n"

                  /* jmp test */
                  "movl $3, %%ecx\n"
                  "1:\n"
                  "addl $1, %0\n"
                  "decl %%ecx\n"
                  "jnz 1b\n"

                  /* movsb: the single step should stop at each movsb iteration */
                  "movl $sstep_buf1, %%esi\n"
                  "movl $sstep_buf2, %%edi\n"
                  "movl $0, %%ecx\n"
                  "rep movsb\n"
                  "movl $3, %%ecx\n"
                  "rep movsb\n"
                  "movl $1, %%ecx\n"
                  "rep movsb\n"

                  /* cmpsb: the single step should stop at each cmpsb iteration */
                  "movl $sstep_buf1, %%esi\n"
                  "movl $sstep_buf2, %%edi\n"
                  "movl $0, %%ecx\n"
                  "rep cmpsb\n"
                  "movl $4, %%ecx\n"
                  "rep cmpsb\n"

                  /* getpid() syscall: single step should skip one
                     instruction */
                  "movl $20, %%eax\n"
                  "int $0x80\n"
                  "movl $0, %%eax\n"

                  /* when modifying SS, trace is not done on the next
                     instruction */
                  "movl %%ss, %%ecx\n"
                  "movl %%ecx, %%ss\n"
                  "addl $1, %0\n"
                  "movl $1, %%eax\n"
                  "movl %%ecx, %%ss\n"
                  "jmp 1f\n"
                  "addl $1, %0\n"
                  "1:\n"
                  "movl $1, %%eax\n"
                  "pushl %%ecx\n"
                  "popl %%ss\n"
                  "addl $1, %0\n"
                  "movl $1, %%eax\n"

                  "pushf\n"
                  "andl $~0x00100, (%%esp)\n"
                  "popf\n"
                  : "=m" (val)
                  :
                  : "cc", "memory", "eax", "ecx", "esi", "edi");
    printf("val=%d\n", val);
    for(i = 0; i < 4; i++)
        printf("sstep_buf2[%d] = %d\n", i, sstep_buf2[i]);
}

/* self modifying code test */
uint8_t code[] = {
    0xb8, 0x1, 0x00, 0x00, 0x00, /* movl $1, %eax */
    0xc3, /* ret */
};

asm(".section \".data\"\n"
    "smc_code2:\n"
    "movl 4(%esp), %eax\n"
    "movl %eax, smc_patch_addr2 + 1\n"
    "nop\n"
    "nop\n"
    "nop\n"
    "nop\n"
    "nop\n"
    "nop\n"
    "nop\n"
    "nop\n"
    "smc_patch_addr2:\n"
    "movl $1, %eax\n"
    "ret\n"
    ".previous\n"
    );

typedef int FuncType(void);
extern int smc_code2(int);
void test_self_modifying_code(void)
{
    int i;
    printf("self modifying code:\n");
    printf("func1 = 0x%x\n", ((FuncType *)code)());
    for(i = 2; i <= 4; i++) {
        code[1] = i;
        printf("func%d = 0x%x\n", i, ((FuncType *)code)());
    }

    /* more difficult test : the modified code is just after the
       modifying instruction. It is forbidden in Intel specs, but it
       is used by old DOS programs */
    for(i = 2; i <= 4; i++) {
        printf("smc_code2(%d) = %d\n", i, smc_code2(i));
    }
}
#endif

long enter_stack[4096];

#if defined(__x86_64__)
#define RSP "%%rsp"
#define RBP "%%rbp"
#else
#define RSP "%%esp"
#define RBP "%%ebp"
#endif

#if !defined(__x86_64__)
/* causes an infinite loop, disable it for now.  */
#define TEST_ENTER(size, stack_type, level)
#else
#define TEST_ENTER(size, stack_type, level)\
{\
    long esp_save, esp_val, ebp_val, ebp_save, i;\
    stack_type *ptr, *stack_end, *stack_ptr;\
    memset(enter_stack, 0, sizeof(enter_stack));\
    stack_end = stack_ptr = (stack_type *)(enter_stack + 4096);\
    ebp_val = (long)stack_ptr;\
    for(i=1;i<=32;i++)\
       *--stack_ptr = i;\
    esp_val = (long)stack_ptr;\
    asm("mov " RSP ", %[esp_save]\n"\
        "mov " RBP ", %[ebp_save]\n"\
        "mov %[esp_val], " RSP "\n"\
        "mov %[ebp_val], " RBP "\n"\
        "enter" size " $8, $" #level "\n"\
        "mov " RSP ", %[esp_val]\n"\
        "mov " RBP ", %[ebp_val]\n"\
        "mov %[esp_save], " RSP "\n"\
        "mov %[ebp_save], " RBP "\n"\
        : [esp_save] "=r" (esp_save),\
        [ebp_save] "=r" (ebp_save),\
        [esp_val] "=r" (esp_val),\
        [ebp_val] "=r" (ebp_val)\
        :  "[esp_val]" (esp_val),\
        "[ebp_val]" (ebp_val));\
    printf("level=%d:\n", level);\
    printf("esp_val=" FMTLX "\n", esp_val - (long)stack_end);\
    printf("ebp_val=" FMTLX "\n", ebp_val - (long)stack_end);\
    for(ptr = (stack_type *)esp_val; ptr < stack_end; ptr++)\
        printf(FMTLX "\n", (long)ptr[0]);\
}
#endif

static void test_enter(void)
{
#if defined(__x86_64__)
    TEST_ENTER("q", uint64_t, 0);
    TEST_ENTER("q", uint64_t, 1);
    TEST_ENTER("q", uint64_t, 2);
    TEST_ENTER("q", uint64_t, 31);
#else
    TEST_ENTER("l", uint32_t, 0);
    TEST_ENTER("l", uint32_t, 1);
    TEST_ENTER("l", uint32_t, 2);
    TEST_ENTER("l", uint32_t, 31);
#endif

    TEST_ENTER("w", uint16_t, 0);
    TEST_ENTER("w", uint16_t, 1);
    TEST_ENTER("w", uint16_t, 2);
    TEST_ENTER("w", uint16_t, 31);
}

#ifdef TEST_SSE

typedef int __m64 __attribute__ ((__mode__ (__V2SI__)));
typedef float __m128 __attribute__ ((__mode__(__V4SF__)));

typedef union {
    double d[2];
    float s[4];
    uint32_t l[4];
    uint64_t q[2];
    __m128 dq;
} XMMReg;

static uint64_t __attribute__((aligned(16))) test_values[4][2] = {
    { 0x456723c698694873, 0xdc515cff944a58ec },
    { 0x1f297ccd58bad7ab, 0x41f21efba9e3e146 },
    { 0x007c62c2085427f8, 0x231be9e8cde7438d },
    { 0x0f76255a085427f8, 0xc233e9e8c4c9439a },
};

#define SSE_OP(op) {}
/*                                              \
{\
    asm volatile (#op " %2, %0" : "=x" (r.dq) : "0" (a.dq), "x" (b.dq));\
    printf("%-9s: a=" FMT64X "" FMT64X " b=" FMT64X "" FMT64X " r=" FMT64X "" FMT64X "\n",\
           #op,\
           a.q[1], a.q[0],\
           b.q[1], b.q[0],\
           r.q[1], r.q[0]);\
}
*/

#define SSE_OP2(op) {}
/*                                              \
{\
    int i;\
    for(i=0;i<2;i++) {\
    a.q[0] = test_values[2*i][0];\
    a.q[1] = test_values[2*i][1];\
    b.q[0] = test_values[2*i+1][0];\
    b.q[1] = test_values[2*i+1][1];\
    SSE_OP(op);\
    }\
}
*/

#define MMX_OP2(op)\
{\
    int i;\
    for(i=0;i<2;i++) {\
    a.q[0] = test_values[2*i][0];\
    b.q[0] = test_values[2*i+1][0];\
    asm volatile (#op " %2, %0" : "=y" (r.q[0]) : "0" (a.q[0]), "y" (b.q[0]));\
    printf("%-9s: a=" FMT64X " b=" FMT64X " r=" FMT64X "\n",\
           #op,\
           a.q[0],\
           b.q[0],\
           r.q[0]);\
    }\
    SSE_OP2(op);\
}


#define SHUF_OP(op, ib)\
{\
    int i;\
    for(i=0;i<2;i++) {\
    a.q[0] = test_values[2*i][0];\
    b.q[0] = test_values[2*i+1][0];\
    asm volatile (#op " $" #ib ", %2, %0" : "=y" (r.q[0]) : "0" (a.q[0]), "y" (b.q[0])); \
    printf("%-9s: a=" FMT64X " b=" FMT64X " ib=%02x r=" FMT64X "\n",\
           #op,\
           a.q[0],\
           b.q[0],\
           ib,\
           r.q[0]);\
    }\
}

/*
#define SHUF_OP(op, ib)\
{\
    a.q[0] = test_values[0][0];\
    a.q[1] = test_values[0][1];\
    b.q[0] = test_values[1][0];\
    b.q[1] = test_values[1][1];\
    asm volatile (#op " $" #ib ", %2, %0" : "=x" (r.dq) : "0" (a.dq), "x" (b.dq));\
    printf("%-9s: a=" FMT64X "" FMT64X " b=" FMT64X "" FMT64X " ib=%02x r=" FMT64X "" FMT64X "\n",\
           #op,\
           a.q[1], a.q[0],\
           b.q[1], b.q[0],\
           ib,\
           r.q[1], r.q[0]);\
}
*/

#define PSHUF_OP(op, ib)\
{\
    int i;\
    for(i=0;i<2;i++) {\
    a.q[0] = test_values[2*i][0];\
    a.q[1] = test_values[2*i][1];\
    asm volatile (#op " $" #ib ", %1, %0" : "=x" (r.dq) : "x" (a.dq));\
    printf("%-9s: a=" FMT64X "" FMT64X " ib=%02x r=" FMT64X "" FMT64X "\n",\
           #op,\
           a.q[1], a.q[0],\
           ib,\
           r.q[1], r.q[0]);\
    }\
}

// To use mm0-7 registers instead of xmm registers
#define SHIFT_IM(op, ib)                        \
{\
    int i;\
    for(i=0;i<2;i++) {\
    a.q[0] = test_values[2*i][0];\
    asm volatile (#op " $" #ib ", %0" : "=y" (r.q[0]) : "0" (a.q[0]));\
    printf("%-9s: a=" FMT64X " ib=%02x r=" FMT64X "\n",\
           #op,\
           a.q[0],\
           ib,\
           r.q[0]);\
    }\
}

/*
#define SHIFT_IM(op, ib)\
{\
    int i;\
    for(i=0;i<2;i++) {\
    a.q[0] = test_values[2*i][0];\
    a.q[1] = test_values[2*i][1];\
    asm volatile (#op " $" #ib ", %0" : "=x" (r.dq) : "0" (a.dq));\
    printf("%-9s: a=" FMT64X "" FMT64X " ib=%02x r=" FMT64X "" FMT64X "\n",\
           #op,\
           a.q[1], a.q[0],\
           ib,\
           r.q[1], r.q[0]);\
    }\
}
*/

// To use mm0-7 registers instead of xmm registers
#define SHIFT_OP(op, ib)\
{\
    int i;\
    SHIFT_IM(op, ib);\
    for(i=0;i<2;i++) {\
    a.q[0] = test_values[2*i][0];\
    b.q[0] = ib;\
    asm volatile (#op " %2, %0" : "=y" (r.q[0]) : "0" (a.q[0]), "y" (b.q[0]));\
    printf("%-9s: a=" FMT64X " b=" FMT64X " ib=%02x r=" FMT64X "\n",\
           #op,\
           a.q[0],\
           b.q[0],\
           ib,\
           r.q[0]);\
    }\
}

/*
#define SHIFT_OP(op, ib)\
{\
    int i;\
    SHIFT_IM(op, ib);\
    for(i=0;i<2;i++) {\
    a.q[0] = test_values[2*i][0];\
    a.q[1] = test_values[2*i][1];\
    b.q[0] = ib;\
    b.q[1] = 0;\
    asm volatile (#op " %2, %0" : "=x" (r.dq) : "0" (a.dq), "x" (b.dq));\
    printf("%-9s: a=" FMT64X "" FMT64X " b=" FMT64X "" FMT64X " r=" FMT64X "" FMT64X "\n",\
           #op,\
           a.q[1], a.q[0],\
           b.q[1], b.q[0],\
           r.q[1], r.q[0]);\
    }\
}
*/

#define MOVMSK(op)\
{\
    int i, reg;\
    for(i=0;i<2;i++) {\
    a.q[0] = test_values[2*i][0];\
    a.q[1] = test_values[2*i][1];\
    asm volatile (#op " %1, %0" : "=r" (reg) : "x" (a.dq));\
    printf("%-9s: a=" FMT64X "" FMT64X " r=%08x\n",\
           #op,\
           a.q[1], a.q[0],\
           reg);\
    }\
}

#define SSE_OPS(a) \
SSE_OP(a ## ps);\
SSE_OP(a ## ss);

#define SSE_OPD(a) \
SSE_OP(a ## pd);\
SSE_OP(a ## sd);

#define SSE_COMI(op, field)\
{\
    unsigned int eflags;\
    XMMReg a, b;\
    a.field[0] = a1;\
    b.field[0] = b1;\
    asm volatile (#op " %2, %1\n"\
        "pushf\n"\
        "pop %0\n"\
        : "=m" (eflags)\
        : "x" (a.dq), "x" (b.dq));\
    printf("%-9s: a=%f b=%f cc=%04x\n",\
           #op, a1, b1,\
           eflags & (CC_C | CC_P | CC_Z | CC_S | CC_O | CC_A));\
}

void test_sse_comi(double a1, double b1)
{
    /*
    SSE_COMI(ucomiss, s);
    SSE_COMI(ucomisd, d);
    SSE_COMI(comiss, s);
    SSE_COMI(comisd, d);
    */
}

#define CVT_OP_XMM(op)\
{\
    asm volatile (#op " %1, %0" : "=x" (r.dq) : "x" (a.dq));\
    printf("%-9s: a=" FMT64X "" FMT64X " r=" FMT64X "" FMT64X "\n",\
           #op,\
           a.q[1], a.q[0],\
           r.q[1], r.q[0]);\
}

/* Force %xmm0 usage to avoid the case where both register index are 0
   to test instruction decoding more extensively */
#define CVT_OP_XMM2MMX(op)\
{\
    asm volatile (#op " %1, %0" : "=y" (r.q[0]) : "x" (a.dq) \
                  : "%xmm0"); \
    asm volatile("emms\n"); \
    printf("%-9s: a=" FMT64X "" FMT64X " r=" FMT64X "\n",\
           #op,\
           a.q[1], a.q[0],\
           r.q[0]);\
}

#define CVT_OP_MMX2XMM(op)\
{\
    asm volatile (#op " %1, %0" : "=x" (r.dq) : "y" (a.q[0]));\
    asm volatile("emms\n"); \
    printf("%-9s: a=" FMT64X " r=" FMT64X "" FMT64X "\n",\
           #op,\
           a.q[0],\
           r.q[1], r.q[0]);\
}

#define CVT_OP_REG2XMM(op)\
{\
    asm volatile (#op " %1, %0" : "=x" (r.dq) : "r" (a.l[0]));\
    printf("%-9s: a=%08x r=" FMT64X "" FMT64X "\n",\
           #op,\
           a.l[0],\
           r.q[1], r.q[0]);\
}

#define CVT_OP_XMM2REG(op)\
{\
    asm volatile (#op " %1, %0" : "=r" (r.l[0]) : "x" (a.dq));\
    printf("%-9s: a=" FMT64X "" FMT64X " r=%08x\n",\
           #op,\
           a.q[1], a.q[0],\
           r.l[0]);\
}

struct fpxstate {
    uint16_t fpuc;
    uint16_t fpus;
    uint16_t fptag;
    uint16_t fop;
    uint32_t fpuip;
    uint16_t cs_sel;
    uint16_t dummy0;
    uint32_t fpudp;
    uint16_t ds_sel;
    uint16_t dummy1;
    uint32_t mxcsr;
    uint32_t mxcsr_mask;
    uint8_t fpregs1[8 * 16];
    uint8_t xmm_regs[8 * 16];
    uint8_t dummy2[224];
};

static struct fpxstate fpx_state __attribute__((aligned(16)));
static struct fpxstate fpx_state2 __attribute__((aligned(16)));

void test_fxsave(void)
{
    struct fpxstate *fp = &fpx_state;
    struct fpxstate *fp2 = &fpx_state2;
    int i, nb_xmm;
    XMMReg a, b;
    a.q[0] = test_values[0][0];
    a.q[1] = test_values[0][1];
    b.q[0] = test_values[1][0];
    b.q[1] = test_values[1][1];

    asm("movdqa %2, %%xmm0\n"
        "movdqa %3, %%xmm7\n"
#if defined(__x86_64__)
        "movdqa %2, %%xmm15\n"
#endif
        " fld1\n"
        " fld1\n"
        " fldz\n"
        " fxsave %0\n"
        " fxrstor %0\n"
        " fxsave %1\n"
        " fninit\n"
        : "=m" (*(uint32_t *)fp2), "=m" (*(uint32_t *)fp)
        : "m" (a), "m" (b));
    printf("fpuc=%04x\n", fp->fpuc);
    printf("fpus=%04x\n", fp->fpus);
    printf("fptag=%04x\n", fp->fptag);
    for(i = 0; i < 3; i++) {
        printf("ST%d: " FMT64X " %04x\n",
               i,
               *(uint64_t *)&fp->fpregs1[i * 16],
               *(uint16_t *)&fp->fpregs1[i * 16 + 8]);
    }
    printf("mxcsr=%08x\n", fp->mxcsr & 0x1f80);
#if defined(__x86_64__)
    nb_xmm = 16;
#else
    nb_xmm = 8;
#endif
    for(i = 0; i < nb_xmm; i++) {
        printf("xmm%d: " FMT64X "" FMT64X "\n",
               i,
               *(uint64_t *)&fp->xmm_regs[i * 16],
               *(uint64_t *)&fp->xmm_regs[i * 16 + 8]);
    }
}

void test_sse(void)
{
    XMMReg r, a, b;
    int i;

    MMX_OP2(punpcklbw);
    MMX_OP2(punpcklwd);
    MMX_OP2(punpckldq);
    MMX_OP2(packsswb);
    MMX_OP2(pcmpgtb);
    MMX_OP2(pcmpgtw);
    MMX_OP2(pcmpgtd);
    MMX_OP2(packuswb);
    MMX_OP2(punpckhbw);
    MMX_OP2(punpckhwd);
    MMX_OP2(punpckhdq);
    MMX_OP2(packssdw);
    MMX_OP2(pcmpeqb);
    MMX_OP2(pcmpeqw);
    MMX_OP2(pcmpeqd);

    // MMX_OP2(paddq);
    MMX_OP2(pmullw);
    MMX_OP2(psubusb);
    MMX_OP2(psubusw);
    // MMX_OP2(pminub);
    MMX_OP2(pand);
    MMX_OP2(paddusb);
    MMX_OP2(paddusw);
    // MMX_OP2(pmaxub);
    MMX_OP2(pandn);

    // MMX_OP2(pmulhuw);
    MMX_OP2(pmulhw);

    MMX_OP2(psubsb);
    MMX_OP2(psubsw);
    // MMX_OP2(pminsw);
    MMX_OP2(por);
    MMX_OP2(paddsb);
    MMX_OP2(paddsw);
    // MMX_OP2(pmaxsw);
    MMX_OP2(pxor);
    // MMX_OP2(pmuludq);
    MMX_OP2(pmaddwd);
    // MMX_OP2(psadbw);
    MMX_OP2(psubb);
    MMX_OP2(psubw);
    MMX_OP2(psubd);
    // MMX_OP2(psubq);
    MMX_OP2(paddb);
    MMX_OP2(paddw);
    MMX_OP2(psrlw);
    MMX_OP2(paddd);

    /*
    MMX_OP2(pavgb);
    MMX_OP2(pavgw);

    asm volatile ("pinsrw $1, %1, %0" : "=y" (r.q[0]) : "r" (0x12345678));
    printf("%-9s: r=" FMT64X "\n", "pinsrw", r.q[0]);

    asm volatile ("pinsrw $5, %1, %0" : "=x" (r.dq) : "r" (0x12345678));
    printf("%-9s: r=" FMT64X "" FMT64X "\n", "pinsrw", r.q[1], r.q[0]);

    a.q[0] = test_values[0][0];
    a.q[1] = test_values[0][1];
    asm volatile ("pextrw $1, %1, %0" : "=r" (r.l[0]) : "y" (a.q[0]));
    printf("%-9s: r=%08x\n", "pextrw", r.l[0]);

    asm volatile ("pextrw $5, %1, %0" : "=r" (r.l[0]) : "x" (a.dq));
    printf("%-9s: r=%08x\n", "pextrw", r.l[0]);

    asm volatile ("pmovmskb %1, %0" : "=r" (r.l[0]) : "y" (a.q[0]));
    printf("%-9s: r=%08x\n", "pmovmskb", r.l[0]);

    asm volatile ("pmovmskb %1, %0" : "=r" (r.l[0]) : "x" (a.dq));
    printf("%-9s: r=%08x\n", "pmovmskb", r.l[0]);

    {
        r.q[0] = -1;
        r.q[1] = -1;

        a.q[0] = test_values[0][0];
        a.q[1] = test_values[0][1];
        b.q[0] = test_values[1][0];
        b.q[1] = test_values[1][1];
        asm volatile("maskmovq %1, %0" :
                     : "y" (a.q[0]), "y" (b.q[0]), "D" (&r)
                     : "memory");
        printf("%-9s: r=" FMT64X " a=" FMT64X " b=" FMT64X "\n",
               "maskmov",
               r.q[0],
               a.q[0],
               b.q[0]);
        asm volatile("maskmovdqu %1, %0" :
                     : "x" (a.dq), "x" (b.dq), "D" (&r)
                     : "memory");
        printf("%-9s: r=" FMT64X "" FMT64X " a=" FMT64X "" FMT64X " b=" FMT64X "" FMT64X "\n",
               "maskmov",
               r.q[1], r.q[0],
               a.q[1], a.q[0],
               b.q[1], b.q[0]);
    }

    asm volatile ("emms");

    SSE_OP2(punpcklqdq);
    SSE_OP2(punpckhqdq);
    SSE_OP2(andps);
    SSE_OP2(andpd);
    SSE_OP2(andnps);
    SSE_OP2(andnpd);
    SSE_OP2(orps);
    SSE_OP2(orpd);
    SSE_OP2(xorps);
    SSE_OP2(xorpd);

    SSE_OP2(unpcklps);
    SSE_OP2(unpcklpd);
    SSE_OP2(unpckhps);
    SSE_OP2(unpckhpd);

    SHUF_OP(shufps, 0x78);
    SHUF_OP(shufpd, 0x02);
    */
    SHUF_OP(pshufw, 0x78);
    SHUF_OP(pshufw, 0x02);
    /*

    PSHUF_OP(pshufd, 0x78);
    PSHUF_OP(pshuflw, 0x78);
    PSHUF_OP(pshufhw, 0x78);
    */

    SHIFT_OP(psrlw, 7);
    SHIFT_OP(psrlw, 16);
    SHIFT_OP(psraw, 7);
    SHIFT_OP(psraw, 16);
    SHIFT_OP(psllw, 7);
    SHIFT_OP(psllw, 16);

    SHIFT_OP(psrld, 7);
    SHIFT_OP(psrld, 32);
    SHIFT_OP(psrad, 7);
    SHIFT_OP(psrad, 32);
    SHIFT_OP(pslld, 7);
    SHIFT_OP(pslld, 32);

    SHIFT_OP(psrlq, 7);
    SHIFT_OP(psrlq, 32);
    SHIFT_OP(psllq, 7);
    SHIFT_OP(psllq, 32);

    /*
    SHIFT_IM(psrldq, 16);
    SHIFT_IM(psrldq, 7);
    SHIFT_IM(pslldq, 16);
    SHIFT_IM(pslldq, 7);

    MOVMSK(movmskps);
    MOVMSK(movmskpd);
    */

    /* FPU specific ops */
    /*
    {
        uint32_t mxcsr;
        asm volatile("stmxcsr %0" : "=m" (mxcsr));
        printf("mxcsr=%08x\n", mxcsr & 0x1f80);
        asm volatile("ldmxcsr %0" : : "m" (mxcsr));
    }

    test_sse_comi(2, -1);
    test_sse_comi(2, 2);
    test_sse_comi(2, 3);
    test_sse_comi(2, q_nan.d);
    test_sse_comi(q_nan.d, -1);

    for(i = 0; i < 2; i++) {
        a.s[0] = 2.7;
        a.s[1] = 3.4;
        a.s[2] = 4;
        a.s[3] = -6.3;
        b.s[0] = 45.7;
        b.s[1] = 353.4;
        b.s[2] = 4;
        b.s[3] = 56.3;
        if (i == 1) {
            a.s[0] = q_nan.d;
            b.s[3] = q_nan.d;
        }

        SSE_OPS(add);
        SSE_OPS(mul);
        SSE_OPS(sub);
        SSE_OPS(min);
        SSE_OPS(div);
        SSE_OPS(max);
        SSE_OPS(sqrt);
        SSE_OPS(cmpeq);
        SSE_OPS(cmplt);
        SSE_OPS(cmple);
        SSE_OPS(cmpunord);
        SSE_OPS(cmpneq);
        SSE_OPS(cmpnlt);
        SSE_OPS(cmpnle);
        SSE_OPS(cmpord);


        a.d[0] = 2.7;
        a.d[1] = -3.4;
        b.d[0] = 45.7;
        b.d[1] = -53.4;
        if (i == 1) {
            a.d[0] = q_nan.d;
            b.d[1] = q_nan.d;
        }
        SSE_OPD(add);
        SSE_OPD(mul);
        SSE_OPD(sub);
        SSE_OPD(min);
        SSE_OPD(div);
        SSE_OPD(max);
        SSE_OPD(sqrt);
        SSE_OPD(cmpeq);
        SSE_OPD(cmplt);
        SSE_OPD(cmple);
        SSE_OPD(cmpunord);
        SSE_OPD(cmpneq);
        SSE_OPD(cmpnlt);
        SSE_OPD(cmpnle);
        SSE_OPD(cmpord);
    }
    */

    /* float to float/int */
    /*
    a.s[0] = 2.7;
    a.s[1] = 3.4;
    a.s[2] = 4;
    a.s[3] = -6.3;
    CVT_OP_XMM(cvtps2pd);
    CVT_OP_XMM(cvtss2sd);
    CVT_OP_XMM2MMX(cvtps2pi);
    CVT_OP_XMM2MMX(cvttps2pi);
    CVT_OP_XMM2REG(cvtss2si);
    CVT_OP_XMM2REG(cvttss2si);
    CVT_OP_XMM(cvtps2dq);
    CVT_OP_XMM(cvttps2dq);

    a.d[0] = 2.6;
    a.d[1] = -3.4;
    CVT_OP_XMM(cvtpd2ps);
    CVT_OP_XMM(cvtsd2ss);
    CVT_OP_XMM2MMX(cvtpd2pi);
    CVT_OP_XMM2MMX(cvttpd2pi);
    CVT_OP_XMM2REG(cvtsd2si);
    CVT_OP_XMM2REG(cvttsd2si);
    CVT_OP_XMM(cvtpd2dq);
    CVT_OP_XMM(cvttpd2dq);
    */

    /* sse/mmx moves */
    /*
    CVT_OP_XMM2MMX(movdq2q);
    CVT_OP_MMX2XMM(movq2dq);
    */

    /* int to float */
    /*
    a.l[0] = -6;
    a.l[1] = 2;
    a.l[2] = 100;
    a.l[3] = -60000;
    CVT_OP_MMX2XMM(cvtpi2ps);
    CVT_OP_MMX2XMM(cvtpi2pd);
    CVT_OP_REG2XMM(cvtsi2ss);
    CVT_OP_REG2XMM(cvtsi2sd);
    CVT_OP_XMM(cvtdq2ps);
    CVT_OP_XMM(cvtdq2pd);
    */
    /* XXX: test PNI insns */
#if 0
    // SSE_OP2(movshdup);
#endif
    asm volatile ("emms");
}

#endif

#define TEST_CONV_RAX(op)\
{\
    unsigned long a, r;\
    a = i2l(0x8234a6f8);\
    r = a;\
    asm volatile(#op : "=a" (r) : "0" (r));\
    printf("%-10s A=" FMTLX " R=" FMTLX "\n", #op, a, r);\
}

#define TEST_CONV_RAX_RDX(op)\
{\
    unsigned long a, d, r, rh;                   \
    a = i2l(0x8234a6f8);\
    d = i2l(0x8345a1f2);\
    r = a;\
    rh = d;\
    asm volatile(#op : "=a" (r), "=d" (rh) : "0" (r), "1" (rh));   \
    printf("%-10s A=" FMTLX " R=" FMTLX ":" FMTLX "\n", #op, a, r, rh);  \
}

void test_conv(void)
{
    TEST_CONV_RAX(cbw);
    TEST_CONV_RAX(cwde);
#if defined(__x86_64__)
    TEST_CONV_RAX(cdqe);
#endif

    TEST_CONV_RAX_RDX(cwd);
    TEST_CONV_RAX_RDX(cdq);
#if defined(__x86_64__)
    TEST_CONV_RAX_RDX(cqo);
#endif

    {
        unsigned long a, r;
        a = i2l(0x12345678);
        asm volatile("bswapl %k0" : "=r" (r) : "0" (a));
        printf("%-10s: A=" FMTLX " R=" FMTLX "\n", "bswapl", a, r);
    }
#if defined(__x86_64__)
    {
        unsigned long a, r;
        a = i2l(0x12345678);
        asm volatile("bswapq %0" : "=r" (r) : "0" (a));
        printf("%-10s: A=" FMTLX " R=" FMTLX "\n", "bswapq", a, r);
    }
#endif
}

extern void *__start_initcall;
extern void *__stop_initcall;


int main(int argc, char **argv)
{
    void **ptr;
    void (*func)(void);

    ptr = &__start_initcall;
    while (ptr != &__stop_initcall) {
        func = *ptr++;
        func();
    }
    test_bsx();
    test_popcnt();
    test_mul();
    test_jcc();
    test_loop();
    test_floats();
#if !defined(__x86_64__)
    test_bcd();
#endif
    test_xchg();
    test_string();
    test_misc();
    test_lea();
#ifdef TEST_SEGS
    test_segs();
    test_code16();
#endif
#ifdef TEST_VM86
    test_vm86();
#endif
#if !defined(__x86_64__)
    test_self_modifying_code();
#endif
    test_enter();
    test_conv();
#ifdef TEST_SSE
    test_sse();
    test_fxsave();
#endif
    test_exceptions();
    //test_single_step();
    return 0;
}
