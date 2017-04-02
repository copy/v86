#include "ioram.h"
#include "vm.h"
#include "libcflat.h"
#include "desc.h"
#include "types.h"
#include "processor.h"

#define memset __builtin_memset
#define TESTDEV_IO_PORT 0xe0

static int exceptions;

struct regs {
	u64 rax, rbx, rcx, rdx;
	u64 rsi, rdi, rsp, rbp;
	u64 r8, r9, r10, r11;
	u64 r12, r13, r14, r15;
	u64 rip, rflags;
};
struct regs inregs, outregs, save;

struct insn_desc {
	u64 ptr;
	size_t len;
};

static char st1[] = "abcdefghijklmnop";

void test_stringio()
{
	unsigned char r = 0;
	asm volatile("cld \n\t"
		     "movw %0, %%dx \n\t"
		     "rep outsb \n\t"
		     : : "i"((short)TESTDEV_IO_PORT),
		       "S"(st1), "c"(sizeof(st1) - 1));
	asm volatile("inb %1, %0\n\t" : "=a"(r) : "i"((short)TESTDEV_IO_PORT));
	report("outsb up", r == st1[sizeof(st1) - 2]); /* last char */

	asm volatile("std \n\t"
		     "movw %0, %%dx \n\t"
		     "rep outsb \n\t"
		     : : "i"((short)TESTDEV_IO_PORT),
		       "S"(st1 + sizeof(st1) - 2), "c"(sizeof(st1) - 1));
	asm volatile("cld \n\t" : : );
	asm volatile("in %1, %0\n\t" : "=a"(r) : "i"((short)TESTDEV_IO_PORT));
	report("outsb down", r == st1[0]);
}

void test_cmps_one(unsigned char *m1, unsigned char *m3)
{
	void *rsi, *rdi;
	long rcx, tmp;

	rsi = m1; rdi = m3; rcx = 30;
	asm volatile("xor %[tmp], %[tmp] \n\t"
		     "repe/cmpsb"
		     : "+S"(rsi), "+D"(rdi), "+c"(rcx), [tmp]"=&r"(tmp)
		     : : "cc");
	report("repe/cmpsb (1)", rcx == 0 && rsi == m1 + 30 && rdi == m3 + 30);

	rsi = m1; rdi = m3; rcx = 30;
	asm volatile("or $1, %[tmp]\n\t" // clear ZF
		     "repe/cmpsb"
		     : "+S"(rsi), "+D"(rdi), "+c"(rcx), [tmp]"=&r"(tmp)
		     : : "cc");
	report("repe/cmpsb (1.zf)", rcx == 0 && rsi == m1 + 30 && rdi == m3 + 30);

	rsi = m1; rdi = m3; rcx = 15;
	asm volatile("xor %[tmp], %[tmp] \n\t"
		     "repe/cmpsw"
		     : "+S"(rsi), "+D"(rdi), "+c"(rcx), [tmp]"=&r"(tmp)
		     : : "cc");
	report("repe/cmpsw (1)", rcx == 0 && rsi == m1 + 30 && rdi == m3 + 30);

	rsi = m1; rdi = m3; rcx = 7;
	asm volatile("xor %[tmp], %[tmp] \n\t"
		     "repe/cmpsl"
		     : "+S"(rsi), "+D"(rdi), "+c"(rcx), [tmp]"=&r"(tmp)
		     : : "cc");
	report("repe/cmpll (1)", rcx == 0 && rsi == m1 + 28 && rdi == m3 + 28);

	rsi = m1; rdi = m3; rcx = 4;
	asm volatile("xor %[tmp], %[tmp] \n\t"
		     "repe/cmpsq"
		     : "+S"(rsi), "+D"(rdi), "+c"(rcx), [tmp]"=&r"(tmp)
		     : : "cc");
	report("repe/cmpsq (1)", rcx == 0 && rsi == m1 + 32 && rdi == m3 + 32);

	rsi = m1; rdi = m3; rcx = 130;
	asm volatile("xor %[tmp], %[tmp] \n\t"
		     "repe/cmpsb"
		     : "+S"(rsi), "+D"(rdi), "+c"(rcx), [tmp]"=&r"(tmp)
		     : : "cc");
	report("repe/cmpsb (2)",
	       rcx == 29 && rsi == m1 + 101 && rdi == m3 + 101);

	rsi = m1; rdi = m3; rcx = 65;
	asm volatile("xor %[tmp], %[tmp] \n\t"
		     "repe/cmpsw"
		     : "+S"(rsi), "+D"(rdi), "+c"(rcx), [tmp]"=&r"(tmp)
		     : : "cc");
	report("repe/cmpsw (2)",
	       rcx == 14 && rsi == m1 + 102 && rdi == m3 + 102);

	rsi = m1; rdi = m3; rcx = 32;
	asm volatile("xor %[tmp], %[tmp] \n\t"
		     "repe/cmpsl"
		     : "+S"(rsi), "+D"(rdi), "+c"(rcx), [tmp]"=&r"(tmp)
		     : : "cc");
	report("repe/cmpll (2)",
	       rcx == 6 && rsi == m1 + 104 && rdi == m3 + 104);

	rsi = m1; rdi = m3; rcx = 16;
	asm volatile("xor %[tmp], %[tmp] \n\t"
		     "repe/cmpsq"
		     : "+S"(rsi), "+D"(rdi), "+c"(rcx), [tmp]"=&r"(tmp)
		     : : "cc");
	report("repe/cmpsq (2)",
	       rcx == 3 && rsi == m1 + 104 && rdi == m3 + 104);

}

void test_cmps(void *mem)
{
	unsigned char *m1 = mem, *m2 = mem + 1024;
	unsigned char m3[1024];

	for (int i = 0; i < 100; ++i)
		m1[i] = m2[i] = m3[i] = i;
	for (int i = 100; i < 200; ++i)
		m1[i] = (m3[i] = m2[i] = i) + 1;
	test_cmps_one(m1, m3);
	test_cmps_one(m1, m2);
}

void test_scas(void *mem)
{
    bool z;
    void *di;

    *(ulong *)mem = 0x77665544332211;

    di = mem;
    asm ("scasb; setz %0" : "=rm"(z), "+D"(di) : "a"(0xff11));
    report("scasb match", di == mem + 1 && z);

    di = mem;
    asm ("scasb; setz %0" : "=rm"(z), "+D"(di) : "a"(0xff54));
    report("scasb mismatch", di == mem + 1 && !z);

    di = mem;
    asm ("scasw; setz %0" : "=rm"(z), "+D"(di) : "a"(0xff2211));
    report("scasw match", di == mem + 2 && z);

    di = mem;
    asm ("scasw; setz %0" : "=rm"(z), "+D"(di) : "a"(0xffdd11));
    report("scasw mismatch", di == mem + 2 && !z);

    di = mem;
    asm ("scasl; setz %0" : "=rm"(z), "+D"(di) : "a"(0xff44332211ul));
    report("scasd match", di == mem + 4 && z);

    di = mem;
    asm ("scasl; setz %0" : "=rm"(z), "+D"(di) : "a"(0x45332211));
    report("scasd mismatch", di == mem + 4 && !z);

    di = mem;
    asm ("scasq; setz %0" : "=rm"(z), "+D"(di) : "a"(0x77665544332211ul));
    report("scasq match", di == mem + 8 && z);

    di = mem;
    asm ("scasq; setz %0" : "=rm"(z), "+D"(di) : "a"(3));
    report("scasq mismatch", di == mem + 8 && !z);
}

void test_cr8(void)
{
	unsigned long src, dst;

	dst = 777;
	src = 3;
	asm volatile("mov %[src], %%cr8; mov %%cr8, %[dst]"
		     : [dst]"+r"(dst), [src]"+r"(src));
	report("mov %%cr8", dst == 3 && src == 3);
}

void test_push(void *mem)
{
	unsigned long tmp;
	unsigned long *stack_top = mem + 4096;
	unsigned long *new_stack_top;
	unsigned long memw = 0x123456789abcdeful;

	memset(mem, 0x55, (void *)stack_top - mem);

	asm volatile("mov %%rsp, %[tmp] \n\t"
		     "mov %[stack_top], %%rsp \n\t"
		     "pushq $-7 \n\t"
		     "pushq %[reg] \n\t"
		     "pushq (%[mem]) \n\t"
		     "pushq $-7070707 \n\t"
		     "mov %%rsp, %[new_stack_top] \n\t"
		     "mov %[tmp], %%rsp"
		     : [tmp]"=&r"(tmp), [new_stack_top]"=r"(new_stack_top)
		     : [stack_top]"r"(stack_top),
		       [reg]"r"(-17l), [mem]"r"(&memw)
		     : "memory");

	report("push $imm8", stack_top[-1] == -7ul);
	report("push %%reg", stack_top[-2] == -17ul);
	report("push mem", stack_top[-3] == 0x123456789abcdeful);
	report("push $imm", stack_top[-4] == -7070707);
}

void test_pop(void *mem)
{
	unsigned long tmp, tmp3, rsp, rbp;
	unsigned long *stack_top = mem + 4096;
	unsigned long memw = 0x123456789abcdeful;
	static unsigned long tmp2;

	memset(mem, 0x55, (void *)stack_top - mem);

	asm volatile("pushq %[val] \n\t"
		     "popq (%[mem])"
		     : : [val]"m"(memw), [mem]"r"(mem) : "memory");
	report("pop mem", *(unsigned long *)mem == memw);

	memw = 7 - memw;
	asm volatile("mov %%rsp, %[tmp] \n\t"
		     "mov %[stack_top], %%rsp \n\t"
		     "pushq %[val] \n\t"
		     "popq %[tmp2] \n\t"
		     "mov %[tmp], %%rsp"
		     : [tmp]"=&r"(tmp), [tmp2]"=m"(tmp2)
		     : [val]"r"(memw), [stack_top]"r"(stack_top)
		     : "memory");
	report("pop mem (2)", tmp2 == memw);

	memw = 129443 - memw;
	asm volatile("mov %%rsp, %[tmp] \n\t"
		     "mov %[stack_top], %%rsp \n\t"
		     "pushq %[val] \n\t"
		     "popq %[tmp2] \n\t"
		     "mov %[tmp], %%rsp"
		     : [tmp]"=&r"(tmp), [tmp2]"=r"(tmp2)
		     : [val]"r"(memw), [stack_top]"r"(stack_top)
		     : "memory");
	report("pop reg", tmp2 == memw);

	asm volatile("mov %%rsp, %[tmp] \n\t"
		     "mov %[stack_top], %%rsp \n\t"
		     "push $1f \n\t"
		     "ret \n\t"
		     "2: jmp 2b \n\t"
		     "1: mov %[tmp], %%rsp"
		     : [tmp]"=&r"(tmp) : [stack_top]"r"(stack_top)
		     : "memory");
	report("ret", 1);

	stack_top[-1] = 0x778899;
	asm volatile("mov %[stack_top], %%r8 \n\t"
		     "mov %%rsp, %%r9 \n\t"
		     "xchg %%rbp, %%r8 \n\t"
		     "leave \n\t"
		     "xchg %%rsp, %%r9 \n\t"
		     "xchg %%rbp, %%r8 \n\t"
		     "mov %%r9, %[tmp] \n\t"
		     "mov %%r8, %[tmp3]"
		     : [tmp]"=&r"(tmp), [tmp3]"=&r"(tmp3) : [stack_top]"r"(stack_top-1)
		     : "memory", "r8", "r9");
	report("leave", tmp == (ulong)stack_top && tmp3 == 0x778899);

	rbp = 0xaa55aa55bb66bb66ULL;
	rsp = (unsigned long)stack_top;
	asm volatile("mov %[rsp], %%r8 \n\t"
		     "mov %[rbp], %%r9 \n\t"
		     "xchg %%rsp, %%r8 \n\t"
		     "xchg %%rbp, %%r9 \n\t"
		     "enter $0x1238, $0 \n\t"
		     "xchg %%rsp, %%r8 \n\t"
		     "xchg %%rbp, %%r9 \n\t"
		     "xchg %%r8, %[rsp] \n\t"
		     "xchg %%r9, %[rbp]"
		     : [rsp]"+a"(rsp), [rbp]"+b"(rbp) : : "memory", "r8", "r9");
	report("enter",
	       rsp == (unsigned long)stack_top - 8 - 0x1238
	       && rbp == (unsigned long)stack_top - 8
	       && stack_top[-1] == 0xaa55aa55bb66bb66ULL);
}

void test_ljmp(void *mem)
{
    unsigned char *m = mem;
    volatile int res = 1;

    *(unsigned long**)m = &&jmpf;
    asm volatile ("data16/mov %%cs, %0":"=m"(*(m + sizeof(unsigned long))));
    asm volatile ("rex64/ljmp *%0"::"m"(*m));
    res = 0;
jmpf:
    report("ljmp", res);
}

void test_incdecnotneg(void *mem)
{
    unsigned long *m = mem, v = 1234;
    unsigned char *mb = mem, vb = 66;

    *m = 0;

    asm volatile ("incl %0":"+m"(*m));
    report("incl",  *m == 1);
    asm volatile ("decl %0":"+m"(*m));
    report("decl",  *m == 0);
    asm volatile ("incb %0":"+m"(*m));
    report("incb",  *m == 1);
    asm volatile ("decb %0":"+m"(*m));
    report("decb",  *m == 0);

    asm volatile ("lock incl %0":"+m"(*m));
    report("lock incl",  *m == 1);
    asm volatile ("lock decl %0":"+m"(*m));
    report("lock decl",  *m == 0);
    asm volatile ("lock incb %0":"+m"(*m));
    report("lock incb",  *m == 1);
    asm volatile ("lock decb %0":"+m"(*m));
    report("lock decb",  *m == 0);

    *m = v;

    asm ("lock negq %0" : "+m"(*m)); v = -v;
    report("lock negl", *m == v);
    asm ("lock notq %0" : "+m"(*m)); v = ~v;
    report("lock notl", *m == v);

    *mb = vb;

    asm ("lock negb %0" : "+m"(*mb)); vb = -vb;
    report("lock negb", *mb == vb);
    asm ("lock notb %0" : "+m"(*mb)); vb = ~vb;
    report("lock notb", *mb == vb);
}

void test_smsw(uint64_t *h_mem)
{
	char mem[16];
	unsigned short msw, msw_orig, *pmsw;
	int i, zero;

	msw_orig = read_cr0();

	asm("smsw %0" : "=r"(msw));
	report("smsw (1)", msw == msw_orig);

	memset(mem, 0, 16);
	pmsw = (void *)mem;
	asm("smsw %0" : "=m"(pmsw[4]));
	zero = 1;
	for (i = 0; i < 8; ++i)
		if (i != 4 && pmsw[i])
			zero = 0;
	report("smsw (2)", msw == pmsw[4] && zero);

	/* Trigger exit on smsw */
	*h_mem = 0x12345678abcdeful;
	asm volatile("smsw %0" : "+m"(*h_mem));
	report("smsw (3)", msw == (unsigned short)*h_mem &&
		(*h_mem & ~0xfffful) == 0x12345678ab0000ul);
}

void test_lmsw(void)
{
	char mem[16];
	unsigned short msw, *pmsw;
	unsigned long cr0;

	cr0 = read_cr0();

	msw = cr0 ^ 8;
	asm("lmsw %0" : : "r"(msw));
	printf("before %lx after %lx\n", cr0, read_cr0());
	report("lmsw (1)", (cr0 ^ read_cr0()) == 8);

	pmsw = (void *)mem;
	*pmsw = cr0;
	asm("lmsw %0" : : "m"(*pmsw));
	printf("before %lx after %lx\n", cr0, read_cr0());
	report("lmsw (2)", cr0 == read_cr0());

	/* lmsw can't clear cr0.pe */
	msw = (cr0 & ~1ul) ^ 4;  /* change EM to force trap */
	asm("lmsw %0" : : "r"(msw));
	report("lmsw (3)", (cr0 ^ read_cr0()) == 4 && (cr0 & 1));

	/* back to normal */
	msw = cr0;
	asm("lmsw %0" : : "r"(msw));
}

void test_xchg(void *mem)
{
	unsigned long *memq = mem;
	unsigned long rax;

	asm volatile("mov $0x123456789abcdef, %%rax\n\t"
		     "mov %%rax, (%[memq])\n\t"
		     "mov $0xfedcba9876543210, %%rax\n\t"
		     "xchg %%al, (%[memq])\n\t"
		     "mov %%rax, %[rax]\n\t"
		     : [rax]"=r"(rax)
		     : [memq]"r"(memq)
		     : "memory", "rax");
	report("xchg reg, r/m (1)",
	       rax == 0xfedcba98765432ef && *memq == 0x123456789abcd10);

	asm volatile("mov $0x123456789abcdef, %%rax\n\t"
		     "mov %%rax, (%[memq])\n\t"
		     "mov $0xfedcba9876543210, %%rax\n\t"
		     "xchg %%ax, (%[memq])\n\t"
		     "mov %%rax, %[rax]\n\t"
		     : [rax]"=r"(rax)
		     : [memq]"r"(memq)
		     : "memory", "rax");
	report("xchg reg, r/m (2)",
	       rax == 0xfedcba987654cdef && *memq == 0x123456789ab3210);

	asm volatile("mov $0x123456789abcdef, %%rax\n\t"
		     "mov %%rax, (%[memq])\n\t"
		     "mov $0xfedcba9876543210, %%rax\n\t"
		     "xchg %%eax, (%[memq])\n\t"
		     "mov %%rax, %[rax]\n\t"
		     : [rax]"=r"(rax)
		     : [memq]"r"(memq)
		     : "memory", "rax");
	report("xchg reg, r/m (3)",
	       rax == 0x89abcdef && *memq == 0x123456776543210);

	asm volatile("mov $0x123456789abcdef, %%rax\n\t"
		     "mov %%rax, (%[memq])\n\t"
		     "mov $0xfedcba9876543210, %%rax\n\t"
		     "xchg %%rax, (%[memq])\n\t"
		     "mov %%rax, %[rax]\n\t"
		     : [rax]"=r"(rax)
		     : [memq]"r"(memq)
		     : "memory", "rax");
	report("xchg reg, r/m (4)",
	       rax == 0x123456789abcdef && *memq == 0xfedcba9876543210);
}

void test_xadd(void *mem)
{
	unsigned long *memq = mem;
	unsigned long rax;

	asm volatile("mov $0x123456789abcdef, %%rax\n\t"
		     "mov %%rax, (%[memq])\n\t"
		     "mov $0xfedcba9876543210, %%rax\n\t"
		     "xadd %%al, (%[memq])\n\t"
		     "mov %%rax, %[rax]\n\t"
		     : [rax]"=r"(rax)
		     : [memq]"r"(memq)
		     : "memory", "rax");
	report("xadd reg, r/m (1)",
	       rax == 0xfedcba98765432ef && *memq == 0x123456789abcdff);

	asm volatile("mov $0x123456789abcdef, %%rax\n\t"
		     "mov %%rax, (%[memq])\n\t"
		     "mov $0xfedcba9876543210, %%rax\n\t"
		     "xadd %%ax, (%[memq])\n\t"
		     "mov %%rax, %[rax]\n\t"
		     : [rax]"=r"(rax)
		     : [memq]"r"(memq)
		     : "memory", "rax");
	report("xadd reg, r/m (2)",
	       rax == 0xfedcba987654cdef && *memq == 0x123456789abffff);

	asm volatile("mov $0x123456789abcdef, %%rax\n\t"
		     "mov %%rax, (%[memq])\n\t"
		     "mov $0xfedcba9876543210, %%rax\n\t"
		     "xadd %%eax, (%[memq])\n\t"
		     "mov %%rax, %[rax]\n\t"
		     : [rax]"=r"(rax)
		     : [memq]"r"(memq)
		     : "memory", "rax");
	report("xadd reg, r/m (3)",
	       rax == 0x89abcdef && *memq == 0x1234567ffffffff);

	asm volatile("mov $0x123456789abcdef, %%rax\n\t"
		     "mov %%rax, (%[memq])\n\t"
		     "mov $0xfedcba9876543210, %%rax\n\t"
		     "xadd %%rax, (%[memq])\n\t"
		     "mov %%rax, %[rax]\n\t"
		     : [rax]"=r"(rax)
		     : [memq]"r"(memq)
		     : "memory", "rax");
	report("xadd reg, r/m (4)",
	       rax == 0x123456789abcdef && *memq == 0xffffffffffffffff);
}

void test_btc(void *mem)
{
	unsigned int *a = mem;

	memset(mem, 0, 4 * sizeof(unsigned int));

	asm ("btcl $32, %0" :: "m"(a[0]) : "memory");
	asm ("btcl $1, %0" :: "m"(a[1]) : "memory");
	asm ("btcl %1, %0" :: "m"(a[0]), "r"(66) : "memory");
	report("btcl imm8, r/m", a[0] == 1 && a[1] == 2 && a[2] == 4);

	asm ("btcl %1, %0" :: "m"(a[3]), "r"(-1) : "memory");
	report("btcl reg, r/m", a[0] == 1 && a[1] == 2 && a[2] == 0x80000004);

	asm ("btcq %1, %0" : : "m"(a[2]), "r"(-1l) : "memory");
	report("btcq reg, r/m", a[0] == 1 && a[1] == 0x80000002 &&
		a[2] == 0x80000004 && a[3] == 0);
}

void test_bsfbsr(void *mem)
{
	unsigned long rax, *memq = mem;
	unsigned eax, *meml = mem;
	unsigned short ax, *memw = mem;
	unsigned char z;

	*memw = 0xc000;
	asm("bsfw %[mem], %[a]" : [a]"=a"(ax) : [mem]"m"(*memw));
	report("bsfw r/m, reg", ax == 14);

	*meml = 0xc0000000;
	asm("bsfl %[mem], %[a]" : [a]"=a"(eax) : [mem]"m"(*meml));
	report("bsfl r/m, reg", eax == 30);

	*memq = 0xc00000000000;
	asm("bsfq %[mem], %[a]" : [a]"=a"(rax) : [mem]"m"(*memq));
	report("bsfq r/m, reg", rax == 46);

	*memq = 0;
	asm("bsfq %[mem], %[a]; setz %[z]"
	    : [a]"=a"(rax), [z]"=rm"(z) : [mem]"m"(*memq));
	report("bsfq r/m, reg", z == 1);

	*memw = 0xc000;
	asm("bsrw %[mem], %[a]" : [a]"=a"(ax) : [mem]"m"(*memw));
	report("bsrw r/m, reg", ax == 15);

	*meml = 0xc0000000;
	asm("bsrl %[mem], %[a]" : [a]"=a"(eax) : [mem]"m"(*meml));
	report("bsrl r/m, reg", eax == 31);

	*memq = 0xc00000000000;
	asm("bsrq %[mem], %[a]" : [a]"=a"(rax) : [mem]"m"(*memq));
	report("bsrq r/m, reg", rax == 47);

	*memq = 0;
	asm("bsrq %[mem], %[a]; setz %[z]"
	    : [a]"=a"(rax), [z]"=rm"(z) : [mem]"m"(*memq));
	report("bsrq r/m, reg", z == 1);
}

static void test_imul(ulong *mem)
{
    ulong a;

    *mem = 51; a = 0x1234567812345678UL;
    asm ("imulw %1, %%ax" : "+a"(a) : "m"(*mem));
    report("imul ax, mem", a == 0x12345678123439e8);

    *mem = 51; a = 0x1234567812345678UL;
    asm ("imull %1, %%eax" : "+a"(a) : "m"(*mem));
    report("imul eax, mem", a == 0xa06d39e8);

    *mem = 51; a = 0x1234567812345678UL;
    asm ("imulq %1, %%rax" : "+a"(a) : "m"(*mem));
    report("imul rax, mem", a == 0xA06D39EBA06D39E8UL);

    *mem  = 0x1234567812345678UL; a = 0x8765432187654321L;
    asm ("imulw $51, %1, %%ax" : "+a"(a) : "m"(*mem));
    report("imul ax, mem, imm8", a == 0x87654321876539e8);

    *mem = 0x1234567812345678UL;
    asm ("imull $51, %1, %%eax" : "+a"(a) : "m"(*mem));
    report("imul eax, mem, imm8", a == 0xa06d39e8);

    *mem = 0x1234567812345678UL;
    asm ("imulq $51, %1, %%rax" : "+a"(a) : "m"(*mem));
    report("imul rax, mem, imm8", a == 0xA06D39EBA06D39E8UL);

    *mem  = 0x1234567812345678UL; a = 0x8765432187654321L;
    asm ("imulw $311, %1, %%ax" : "+a"(a) : "m"(*mem));
    report("imul ax, mem, imm", a == 0x8765432187650bc8);

    *mem = 0x1234567812345678UL;
    asm ("imull $311, %1, %%eax" : "+a"(a) : "m"(*mem));
    report("imul eax, mem, imm", a == 0x1d950bc8);

    *mem = 0x1234567812345678UL;
    asm ("imulq $311, %1, %%rax" : "+a"(a) : "m"(*mem));
    report("imul rax, mem, imm", a == 0x1D950BDE1D950BC8L);
}

static void test_muldiv(long *mem)
{
    long a, d, aa, dd;
    u8 ex = 1;

    *mem = 0; a = 1; d = 2;
    asm (ASM_TRY("1f") "divq %3; movb $0, %2; 1:"
	 : "+a"(a), "+d"(d), "+q"(ex) : "m"(*mem));
    report("divq (fault)", a == 1 && d == 2 && ex);

    *mem = 987654321098765UL; a = 123456789012345UL; d = 123456789012345UL;
    asm (ASM_TRY("1f") "divq %3; movb $0, %2; 1:"
	 : "+a"(a), "+d"(d), "+q"(ex) : "m"(*mem));
    report("divq (1)",
	   a == 0x1ffffffb1b963b33ul && d == 0x273ba4384ede2ul && !ex);
    aa = 0x1111111111111111; dd = 0x2222222222222222;
    *mem = 0x3333333333333333; a = aa; d = dd;
    asm("mulb %2" : "+a"(a), "+d"(d) : "m"(*mem));
    report("mulb mem", a == 0x1111111111110363 && d == dd);
    *mem = 0x3333333333333333; a = aa; d = dd;
    asm("mulw %2" : "+a"(a), "+d"(d) : "m"(*mem));
    report("mulw mem", a == 0x111111111111c963 && d == 0x2222222222220369);
    *mem = 0x3333333333333333; a = aa; d = dd;
    asm("mull %2" : "+a"(a), "+d"(d) : "m"(*mem));
    report("mull mem", a == 0x962fc963 && d == 0x369d036);
    *mem = 0x3333333333333333; a = aa; d = dd;
    asm("mulq %2" : "+a"(a), "+d"(d) : "m"(*mem));
    report("mulq mem", a == 0x2fc962fc962fc963 && d == 0x369d0369d0369d0);
}

typedef unsigned __attribute__((vector_size(16))) sse128;

typedef union {
    sse128 sse;
    unsigned u[4];
} sse_union;

static bool sseeq(sse_union *v1, sse_union *v2)
{
    bool ok = true;
    int i;

    for (i = 0; i < 4; ++i) {
	ok &= v1->u[i] == v2->u[i];
    }

    return ok;
}

static void test_sse(sse_union *mem)
{
    sse_union v;

    write_cr0(read_cr0() & ~6); /* EM, TS */
    write_cr4(read_cr4() | 0x200); /* OSFXSR */
    v.u[0] = 1; v.u[1] = 2; v.u[2] = 3; v.u[3] = 4;
    asm("movdqu %1, %0" : "=m"(*mem) : "x"(v.sse));
    report("movdqu (read)", sseeq(&v, mem));
    mem->u[0] = 5; mem->u[1] = 6; mem->u[2] = 7; mem->u[3] = 8;
    asm("movdqu %1, %0" : "=x"(v.sse) : "m"(*mem));
    report("movdqu (write)", sseeq(mem, &v));

    v.u[0] = 1; v.u[1] = 2; v.u[2] = 3; v.u[3] = 4;
    asm("movaps %1, %0" : "=m"(*mem) : "x"(v.sse));
    report("movaps (read)", sseeq(mem, &v));
    mem->u[0] = 5; mem->u[1] = 6; mem->u[2] = 7; mem->u[3] = 8;
    asm("movaps %1, %0" : "=x"(v.sse) : "m"(*mem));
    report("movaps (write)", sseeq(&v, mem));

    v.u[0] = 1; v.u[1] = 2; v.u[2] = 3; v.u[3] = 4;
    asm("movapd %1, %0" : "=m"(*mem) : "x"(v.sse));
    report("movapd (read)", sseeq(mem, &v));
    mem->u[0] = 5; mem->u[1] = 6; mem->u[2] = 7; mem->u[3] = 8;
    asm("movapd %1, %0" : "=x"(v.sse) : "m"(*mem));
    report("movapd (write)", sseeq(&v, mem));
}

static void test_mmx(uint64_t *mem)
{
    uint64_t v;

    write_cr0(read_cr0() & ~6); /* EM, TS */
    asm volatile("fninit");
    v = 0x0102030405060708ULL;
    asm("movq %1, %0" : "=m"(*mem) : "y"(v));
    report("movq (mmx, read)", v == *mem);
    *mem = 0x8070605040302010ull;
    asm("movq %1, %0" : "=y"(v) : "m"(*mem));
    report("movq (mmx, write)", v == *mem);
}

static void test_rip_relative(unsigned *mem, char *insn_ram)
{
    /* movb $1, mem+2(%rip) */
    insn_ram[0] = 0xc6;
    insn_ram[1] = 0x05;
    *(unsigned *)&insn_ram[2] = 2 + (char *)mem - (insn_ram + 7);
    insn_ram[6] = 0x01;
    /* ret */
    insn_ram[7] = 0xc3;

    *mem = 0;
    asm("callq *%1" : "+m"(*mem) : "r"(insn_ram));
    report("movb $imm, 0(%%rip)", *mem == 0x10000);
}

static void test_shld_shrd(u32 *mem)
{
    *mem = 0x12345678;
    asm("shld %2, %1, %0" : "+m"(*mem) : "r"(0xaaaaaaaaU), "c"((u8)3));
    report("shld (cl)", *mem == ((0x12345678 << 3) | 5));
    *mem = 0x12345678;
    asm("shrd %2, %1, %0" : "+m"(*mem) : "r"(0x55555555U), "c"((u8)3));
    report("shrd (cl)", *mem == ((0x12345678 >> 3) | (5u << 29)));
}

static void test_cmov(u32 *mem)
{
	u64 val;
	*mem = 0xabcdef12u;
	asm ("movq $0x1234567812345678, %%rax\n\t"
	     "cmpl %%eax, %%eax\n\t"
	     "cmovnel (%[mem]), %%eax\n\t"
	     "movq %%rax, %[val]\n\t"
	     : [val]"=r"(val) : [mem]"r"(mem) : "%rax", "cc");
	report("cmovnel", val == 0x12345678ul);
}

#define INSN_XCHG_ALL				\
	"xchg %rax, 0+save \n\t"		\
	"xchg %rbx, 8+save \n\t"		\
	"xchg %rcx, 16+save \n\t"		\
	"xchg %rdx, 24+save \n\t"		\
	"xchg %rsi, 32+save \n\t"		\
	"xchg %rdi, 40+save \n\t"		\
	"xchg %rsp, 48+save \n\t"		\
	"xchg %rbp, 56+save \n\t"		\
	"xchg %r8, 64+save \n\t"		\
	"xchg %r9, 72+save \n\t"		\
	"xchg %r10, 80+save \n\t"		\
	"xchg %r11, 88+save \n\t"		\
	"xchg %r12, 96+save \n\t"		\
	"xchg %r13, 104+save \n\t"		\
	"xchg %r14, 112+save \n\t"		\
	"xchg %r15, 120+save \n\t"

asm(
	".align 4096\n\t"
	"insn_page:\n\t"
	"ret\n\t"
	"pushf\n\t"
	"push 136+save \n\t"
	"popf \n\t"
	INSN_XCHG_ALL
	"test_insn:\n\t"
	"in  (%dx),%al\n\t"
	".skip 31, 0x90\n\t"
	"test_insn_end:\n\t"
	INSN_XCHG_ALL
	"pushf \n\t"
	"pop 136+save \n\t"
	"popf \n\t"
	"ret \n\t"
	"insn_page_end:\n\t"
	".align 4096\n\t"
);

#define MK_INSN(name, str)				\
    asm (						\
	 ".pushsection .data.insn  \n\t"		\
	 "insn_" #name ": \n\t"				\
	 ".quad 1001f, 1002f - 1001f \n\t"		\
	 ".popsection \n\t"				\
	 ".pushsection .text.insn, \"ax\" \n\t"		\
	 "1001: \n\t"					\
	 "insn_code_" #name ": " str " \n\t"		\
	 "1002: \n\t"					\
	 ".popsection"					\
    );							\
    extern struct insn_desc insn_##name;

static void trap_emulator(uint64_t *mem, void *alt_insn_page,
			struct insn_desc *alt_insn)
{
	ulong *cr3 = (ulong *)read_cr3();
	void *insn_ram;
	extern u8 insn_page[], test_insn[];

	insn_ram = vmap(virt_to_phys(insn_page), 4096);
	memcpy(alt_insn_page, insn_page, 4096);
	memcpy(alt_insn_page + (test_insn - insn_page),
			(void *)(alt_insn->ptr), alt_insn->len);
	save = inregs;

	/* Load the code TLB with insn_page, but point the page tables at
	   alt_insn_page (and keep the data TLB clear, for AMD decode assist).
	   This will make the CPU trap on the insn_page instruction but the
	   hypervisor will see alt_insn_page. */
	install_page(cr3, virt_to_phys(insn_page), insn_ram);
	invlpg(insn_ram);
	/* Load code TLB */
	asm volatile("call *%0" : : "r"(insn_ram));
	install_page(cr3, virt_to_phys(alt_insn_page), insn_ram);
	/* Trap, let hypervisor emulate at alt_insn_page */
	asm volatile("call *%0": : "r"(insn_ram+1));

	outregs = save;
}

static unsigned long rip_advance;

static void advance_rip_and_note_exception(struct ex_regs *regs)
{
    ++exceptions;
    regs->rip += rip_advance;
}

static void test_mmx_movq_mf(uint64_t *mem, uint8_t *insn_page,
			     uint8_t *alt_insn_page, void *insn_ram)
{
    uint16_t fcw = 0;  /* all exceptions unmasked */
    /* movq %mm0, (%rax) */
    void *stack = alloc_page();

    write_cr0(read_cr0() & ~6);  /* TS, EM */
    exceptions = 0;
    handle_exception(MF_VECTOR, advance_rip_and_note_exception);
    asm volatile("fninit; fldcw %0" : : "m"(fcw));
    asm volatile("fldz; fldz; fdivp"); /* generate exception */

    MK_INSN(mmx_movq_mf, "movq %mm0, (%rax) \n\t");
    rip_advance = insn_mmx_movq_mf.len;
    inregs = (struct regs){ .rsp=(u64)stack+1024 };
    trap_emulator(mem, alt_insn_page, &insn_mmx_movq_mf);
    /* exit MMX mode */
    asm volatile("fnclex; emms");
    report("movq mmx generates #MF", exceptions == 1);
    handle_exception(MF_VECTOR, 0);
}

static void test_jmp_noncanonical(uint64_t *mem)
{
	extern char nc_jmp_start, nc_jmp_end;

	*mem = 0x1111111111111111ul;

	exceptions = 0;
	rip_advance = &nc_jmp_end - &nc_jmp_start;
	handle_exception(GP_VECTOR, advance_rip_and_note_exception);
	asm volatile ("nc_jmp_start: jmp *%0; nc_jmp_end:" : : "m"(*mem));
	report("jump to non-canonical address", exceptions == 1);
	handle_exception(GP_VECTOR, 0);
}

static void test_movabs(uint64_t *mem, uint8_t *insn_page,
		       uint8_t *alt_insn_page, void *insn_ram)
{
    /* mov $0x9090909090909090, %rcx */
    MK_INSN(movabs, "mov $0x9090909090909090, %rcx\n\t");
    inregs = (struct regs){ 0 };
    trap_emulator(mem, alt_insn_page, &insn_movabs);
    report("64-bit mov imm2", outregs.rcx == 0x9090909090909090);
}

static void test_smsw_reg(uint64_t *mem, uint8_t *insn_page,
		      uint8_t *alt_insn_page, void *insn_ram)
{
	unsigned long cr0 = read_cr0();
	inregs = (struct regs){ .rax = 0x1234567890abcdeful };

	MK_INSN(smsww, "smsww %ax\n\t");
	trap_emulator(mem, alt_insn_page, &insn_smsww);
	report("16-bit smsw reg", (u16)outregs.rax == (u16)cr0 &&
				  outregs.rax >> 16 == inregs.rax >> 16);

	MK_INSN(smswl, "smswl %eax\n\t");
	trap_emulator(mem, alt_insn_page, &insn_smswl);
	report("32-bit smsw reg", outregs.rax == (u32)cr0);

	MK_INSN(smswq, "smswq %rax\n\t");
	trap_emulator(mem, alt_insn_page, &insn_smswq);
	report("64-bit smsw reg", outregs.rax == cr0);
}

static void test_nop(uint64_t *mem, uint8_t *insn_page,
		uint8_t *alt_insn_page, void *insn_ram)
{
	inregs = (struct regs){ .rax = 0x1234567890abcdeful };
	MK_INSN(nop, "nop\n\t");
	trap_emulator(mem, alt_insn_page, &insn_nop);
	report("nop", outregs.rax == inregs.rax);
}

static void test_mov_dr(uint64_t *mem, uint8_t *insn_page,
		uint8_t *alt_insn_page, void *insn_ram)
{
	bool rtm_support = cpuid(7).b & (1 << 11);
	unsigned long dr6_fixed_1 = rtm_support ? 0xfffe0ff0ul : 0xffff0ff0ul;
	inregs = (struct regs){ .rax = 0 };
	MK_INSN(mov_to_dr6, "movq %rax, %dr6\n\t");
	trap_emulator(mem, alt_insn_page, &insn_mov_to_dr6);
	MK_INSN(mov_from_dr6, "movq %dr6, %rax\n\t");
	trap_emulator(mem, alt_insn_page, &insn_mov_from_dr6);
	report("mov_dr6", outregs.rax == dr6_fixed_1);
}

static void test_push16(uint64_t *mem)
{
	uint64_t rsp1, rsp2;
	uint16_t r;

	asm volatile (	"movq %%rsp, %[rsp1]\n\t"
			"pushw %[v]\n\t"
			"popw %[r]\n\t"
			"movq %%rsp, %[rsp2]\n\t"
			"movq %[rsp1], %%rsp\n\t" :
			[rsp1]"=r"(rsp1), [rsp2]"=r"(rsp2), [r]"=r"(r)
			: [v]"m"(*mem) : "memory");
	report("push16", rsp1 == rsp2);
}

static void test_crosspage_mmio(volatile uint8_t *mem)
{
    volatile uint16_t w, *pw;

    pw = (volatile uint16_t *)&mem[4095];
    mem[4095] = 0x99;
    mem[4096] = 0x77;
    asm volatile("mov %1, %0" : "=r"(w) : "m"(*pw) : "memory");
    report("cross-page mmio read", w == 0x7799);
    asm volatile("mov %1, %0" : "=m"(*pw) : "r"((uint16_t)0x88aa));
    report("cross-page mmio write", mem[4095] == 0xaa && mem[4096] == 0x88);
}

static void test_string_io_mmio(volatile uint8_t *mem)
{
	/* Cross MMIO pages.*/
	volatile uint8_t *mmio = mem + 4032;

	asm volatile("outw %%ax, %%dx  \n\t" : : "a"(0x9999), "d"(TESTDEV_IO_PORT));

	asm volatile ("cld; rep insb" : : "d" (TESTDEV_IO_PORT), "D" (mmio), "c" (1024));

	report("string_io_mmio", mmio[1023] == 0x99);
}

/* kvm doesn't allow lidt/lgdt from mmio, so the test is disabled */
#if 0
static void test_lgdt_lidt(volatile uint8_t *mem)
{
    struct descriptor_table_ptr orig, fresh = {};

    sgdt(&orig);
    *(struct descriptor_table_ptr *)mem = (struct descriptor_table_ptr) {
	.limit = 0xf234,
	.base = 0x12345678abcd,
    };
    cli();
    asm volatile("lgdt %0" : : "m"(*(struct descriptor_table_ptr *)mem));
    sgdt(&fresh);
    lgdt(&orig);
    sti();
    report("lgdt (long address)", orig.limit == fresh.limit && orig.base == fresh.base);

    sidt(&orig);
    *(struct descriptor_table_ptr *)mem = (struct descriptor_table_ptr) {
	.limit = 0x432f,
	.base = 0xdbca87654321,
    };
    cli();
    asm volatile("lidt %0" : : "m"(*(struct descriptor_table_ptr *)mem));
    sidt(&fresh);
    lidt(&orig);
    sti();
    report("lidt (long address)", orig.limit == fresh.limit && orig.base == fresh.base);
}
#endif

static void ss_bad_rpl(struct ex_regs *regs)
{
    extern char ss_bad_rpl_cont;

    ++exceptions;
    regs->rip = (ulong)&ss_bad_rpl_cont;
}

static void test_sreg(volatile uint16_t *mem)
{
    u16 ss = read_ss();

    // check for null segment load
    *mem = 0;
    asm volatile("mov %0, %%ss" : : "m"(*mem));
    report("mov null, %%ss", read_ss() == 0);

    // check for exception when ss.rpl != cpl on null segment load
    exceptions = 0;
    handle_exception(GP_VECTOR, ss_bad_rpl);
    *mem = 3;
    asm volatile("mov %0, %%ss; ss_bad_rpl_cont:" : : "m"(*mem));
    report("mov null, %%ss (with ss.rpl != cpl)", exceptions == 1 && read_ss() == 0);
    handle_exception(GP_VECTOR, 0);
    write_ss(ss);
}

/* Broken emulation causes triple fault, which skips the other tests. */
#if 0
static void test_lldt(volatile uint16_t *mem)
{
    u64 gdt[] = { 0, /* null descriptor */
#ifdef __X86_64__
		  0, /* ldt descriptor is 16 bytes in long mode */
#endif
		  0x0000f82000000ffffull /* ldt descriptor */ };
    struct descriptor_table_ptr gdt_ptr = { .limit = sizeof(gdt) - 1,
					    .base = (ulong)&gdt };
    struct descriptor_table_ptr orig_gdt;

    cli();
    sgdt(&orig_gdt);
    lgdt(&gdt_ptr);
    *mem = 0x8;
    asm volatile("lldt %0" : : "m"(*mem));
    lgdt(&orig_gdt);
    sti();
    report("lldt", sldt() == *mem);
}
#endif

static void test_ltr(volatile uint16_t *mem)
{
    struct descriptor_table_ptr gdt_ptr;
    uint64_t *gdt, *trp;
    uint16_t tr = str();
    uint64_t busy_mask = (uint64_t)1 << 41;

    sgdt(&gdt_ptr);
    gdt = (uint64_t *)gdt_ptr.base;
    trp = &gdt[tr >> 3];
    *trp &= ~busy_mask;
    *mem = tr;
    asm volatile("ltr %0" : : "m"(*mem) : "memory");
    report("ltr", str() == tr && (*trp & busy_mask));
}

static void test_simplealu(u32 *mem)
{
    *mem = 0x1234;
    asm("or %1, %0" : "+m"(*mem) : "r"(0x8001));
    report("or", *mem == 0x9235);
    asm("add %1, %0" : "+m"(*mem) : "r"(2));
    report("add", *mem == 0x9237);
    asm("xor %1, %0" : "+m"(*mem) : "r"(0x1111));
    report("xor", *mem == 0x8326);
    asm("sub %1, %0" : "+m"(*mem) : "r"(0x26));
    report("sub", *mem == 0x8300);
    asm("clc; adc %1, %0" : "+m"(*mem) : "r"(0x100));
    report("adc(0)", *mem == 0x8400);
    asm("stc; adc %1, %0" : "+m"(*mem) : "r"(0x100));
    report("adc(0)", *mem == 0x8501);
    asm("clc; sbb %1, %0" : "+m"(*mem) : "r"(0));
    report("sbb(0)", *mem == 0x8501);
    asm("stc; sbb %1, %0" : "+m"(*mem) : "r"(0));
    report("sbb(1)", *mem == 0x8500);
    asm("and %1, %0" : "+m"(*mem) : "r"(0xfe77));
    report("and", *mem == 0x8400);
    asm("test %1, %0" : "+m"(*mem) : "r"(0xf000));
    report("test", *mem == 0x8400);
}

static void illegal_movbe_handler(struct ex_regs *regs)
{
	extern char bad_movbe_cont;

	++exceptions;
	regs->rip = (ulong)&bad_movbe_cont;
}

static void test_illegal_movbe(void)
{
	if (!(cpuid(1).c & (1 << 22))) {
		report_skip("illegal movbe");
		return;
	}

	exceptions = 0;
	handle_exception(UD_VECTOR, illegal_movbe_handler);
	asm volatile(".byte 0x0f; .byte 0x38; .byte 0xf0; .byte 0xc0;\n\t"
		     " bad_movbe_cont:" : : : "rax");
	report("illegal movbe", exceptions == 1);
	handle_exception(UD_VECTOR, 0);
}

int main()
{
	void *mem;
	void *insn_page, *alt_insn_page;
	void *insn_ram;
	unsigned long t1, t2;

	setup_vm();
	setup_idt();
	mem = alloc_vpages(2);
	install_page((void *)read_cr3(), IORAM_BASE_PHYS, mem);
	// install the page twice to test cross-page mmio
	install_page((void *)read_cr3(), IORAM_BASE_PHYS, mem + 4096);
	insn_page = alloc_page();
	alt_insn_page = alloc_page();
	insn_ram = vmap(virt_to_phys(insn_page), 4096);

	// test mov reg, r/m and mov r/m, reg
	t1 = 0x123456789abcdef;
	asm volatile("mov %[t1], (%[mem]) \n\t"
		     "mov (%[mem]), %[t2]"
		     : [t2]"=r"(t2)
		     : [t1]"r"(t1), [mem]"r"(mem)
		     : "memory");
	report("mov reg, r/m (1)", t2 == 0x123456789abcdef);

	test_simplealu(mem);
	test_cmps(mem);
	test_scas(mem);

	test_push(mem);
	test_pop(mem);

	test_xchg(mem);
	test_xadd(mem);

	test_cr8();

	test_smsw(mem);
	test_lmsw();
	test_ljmp(mem);
	test_stringio();
	test_incdecnotneg(mem);
	test_btc(mem);
	test_bsfbsr(mem);
	test_imul(mem);
	test_muldiv(mem);
	test_sse(mem);
	test_mmx(mem);
	test_rip_relative(mem, insn_ram);
	test_shld_shrd(mem);
	//test_lgdt_lidt(mem);
	test_sreg(mem);
	//test_lldt(mem);
	test_ltr(mem);
	test_cmov(mem);

	test_mmx_movq_mf(mem, insn_page, alt_insn_page, insn_ram);
	test_movabs(mem, insn_page, alt_insn_page, insn_ram);
	test_smsw_reg(mem, insn_page, alt_insn_page, insn_ram);
	test_nop(mem, insn_page, alt_insn_page, insn_ram);
	test_mov_dr(mem, insn_page, alt_insn_page, insn_ram);
	test_push16(mem);
	test_crosspage_mmio(mem);

	test_string_io_mmio(mem);

	test_jmp_noncanonical(mem);
	test_illegal_movbe();

	return report_summary();
}
