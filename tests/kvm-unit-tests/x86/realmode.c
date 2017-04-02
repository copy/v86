#ifndef USE_SERIAL
#define USE_SERIAL
#endif

asm(".code16gcc");

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned u32;
typedef unsigned long long u64;

void test_function(void);

asm(
	"test_function: \n\t"
	"mov $0x1234, %eax \n\t"
	"ret"
   );

static int strlen(const char *str)
{
	int n;

	for (n = 0; *str; ++str)
		++n;
	return n;
}

static void outb(u8 data, u16 port)
{
	asm volatile("out %0, %1" : : "a"(data), "d"(port));
}

#ifdef USE_SERIAL
static int serial_iobase = 0x3f8;
static int serial_inited = 0;

static u8 inb(u16 port)
{
	u8 data;
	asm volatile("in %1, %0" : "=a"(data) : "d"(port));
	return data;
}

static void serial_outb(char ch)
{
	u8 lsr;

	do {
		lsr = inb(serial_iobase + 0x05);
	} while (!(lsr & 0x20));

	outb(ch, serial_iobase + 0x00);
}

static void serial_init(void)
{
	u8 lcr;

	/* set DLAB */
	lcr = inb(serial_iobase + 0x03);
	lcr |= 0x80;
	outb(lcr, serial_iobase + 0x03);

	/* set baud rate to 115200 */
	outb(0x01, serial_iobase + 0x00);
	outb(0x00, serial_iobase + 0x01);

	/* clear DLAB */
	lcr = inb(serial_iobase + 0x03);
	lcr &= ~0x80;
	outb(lcr, serial_iobase + 0x03);
}
#endif

static void print_serial(const char *buf)
{
	unsigned long len = strlen(buf);
#ifdef USE_SERIAL
	unsigned long i;
	if (!serial_inited) {
	    serial_init();
	    serial_inited = 1;
	}

	for (i = 0; i < len; i++) {
	    serial_outb(buf[i]);
	}
#else
	asm volatile ("addr32/rep/outsb" : "+S"(buf), "+c"(len) : "d"(0xf1));
#endif
}

static void print_serial_u32(u32 value)
{
	char n[12], *p;
	p = &n[11];
	*p = 0;
	do {
		*--p = '0' + (value % 10);
		value /= 10;
	} while (value > 0);
	print_serial(p);
}

static int failed;

static void exit(int code)
{
	outb(code, 0xf4);
}

struct regs {
	u32 eax, ebx, ecx, edx;
	u32 esi, edi, esp, ebp;
	u32 eip, eflags;
};

struct table_descr {
	u16 limit;
	void *base;
} __attribute__((packed));

static u64 gdt[] = {
	0,
	0x00cf9b000000ffffull, // flat 32-bit code segment
	0x00cf93000000ffffull, // flat 32-bit data segment
};

static struct table_descr gdt_descr = {
	sizeof(gdt) - 1,
	gdt,
};

struct insn_desc {
    u16 ptr;
    u16 len;
};

static struct regs inregs, outregs;

static void exec_in_big_real_mode(struct insn_desc *insn)
{
	unsigned long tmp;
	static struct regs save;
	int i;
	extern u8 test_insn[], test_insn_end[];

	for (i = 0; i < insn->len; ++i)
	    test_insn[i] = ((u8 *)(unsigned long)insn->ptr)[i];
	for (; i < test_insn_end - test_insn; ++i)
		test_insn[i] = 0x90; // nop

	save = inregs;
	asm volatile(
		"lgdtl %[gdt_descr] \n\t"
		"mov %%cr0, %[tmp] \n\t"
		"or $1, %[tmp] \n\t"
		"mov %[tmp], %%cr0 \n\t"
		"mov %[bigseg], %%gs \n\t"
		"and $-2, %[tmp] \n\t"
		"mov %[tmp], %%cr0 \n\t"

                "pushw %[save]+36; popfw \n\t"
		"xchg %%eax, %[save]+0 \n\t"
		"xchg %%ebx, %[save]+4 \n\t"
		"xchg %%ecx, %[save]+8 \n\t"
		"xchg %%edx, %[save]+12 \n\t"
		"xchg %%esi, %[save]+16 \n\t"
		"xchg %%edi, %[save]+20 \n\t"
		"xchg %%esp, %[save]+24 \n\t"
		"xchg %%ebp, %[save]+28 \n\t"

		"test_insn: . = . + 32\n\t"
		"test_insn_end: \n\t"

		"xchg %%eax, %[save]+0 \n\t"
		"xchg %%ebx, %[save]+4 \n\t"
		"xchg %%ecx, %[save]+8 \n\t"
		"xchg %%edx, %[save]+12 \n\t"
		"xchg %%esi, %[save]+16 \n\t"
		"xchg %%edi, %[save]+20 \n\t"
		"xchg %%esp, %[save]+24 \n\t"
		"xchg %%ebp, %[save]+28 \n\t"

		/* Save EFLAGS in outregs*/
		"pushfl \n\t"
		"popl %[save]+36 \n\t"

		/* Restore DF for the harness code */
		"cld\n\t"
		"xor %[tmp], %[tmp] \n\t"
		"mov %[tmp], %%gs \n\t"
		: [tmp]"=&r"(tmp), [save]"+m"(save)
		: [gdt_descr]"m"(gdt_descr), [bigseg]"r"((short)16)
		: "cc", "memory"
		);
	outregs = save;
}

#define R_AX 1
#define R_BX 2
#define R_CX 4
#define R_DX 8
#define R_SI 16
#define R_DI 32
#define R_SP 64
#define R_BP 128

int regs_equal(int ignore)
{
	const u32 *p1 = &inregs.eax, *p2 = &outregs.eax;  // yuck
	int i;

	for (i = 0; i < 8; ++i)
		if (!(ignore & (1 << i)) && p1[i] != p2[i])
			return 0;
	return 1;
}

static void report(const char *name, u16 regs_ignore, _Bool ok)
{
    if (!regs_equal(regs_ignore)) {
	ok = 0;
    }
    print_serial(ok ? "PASS: " : "FAIL: ");
    print_serial(name);
    print_serial("\n");
    if (!ok)
	failed = 1;
}

#define MK_INSN(name, str)				\
    asm (						\
	 ".pushsection .data.insn  \n\t"		\
	 "insn_" #name ": \n\t"				\
	 ".word 1001f, 1002f - 1001f \n\t"		\
	 ".popsection \n\t"				\
	 ".pushsection .text.insn, \"ax\" \n\t"		\
	 "1001: \n\t"					\
	 "insn_code_" #name ": " str " \n\t"		\
	 "1002: \n\t"					\
	 ".popsection"					\
    );							\
    extern struct insn_desc insn_##name;

void test_xchg(void)
{
	MK_INSN(xchg_test1, "xchg %eax,%eax\n\t");
	MK_INSN(xchg_test2, "xchg %eax,%ebx\n\t");
	MK_INSN(xchg_test3, "xchg %eax,%ecx\n\t");
	MK_INSN(xchg_test4, "xchg %eax,%edx\n\t");
	MK_INSN(xchg_test5, "xchg %eax,%esi\n\t");
	MK_INSN(xchg_test6, "xchg %eax,%edi\n\t");
	MK_INSN(xchg_test7, "xchg %eax,%ebp\n\t");
	MK_INSN(xchg_test8, "xchg %eax,%esp\n\t");

	inregs = (struct regs){ .eax = 0, .ebx = 1, .ecx = 2, .edx = 3, .esi = 4, .edi = 5, .ebp = 6, .esp = 7};

	exec_in_big_real_mode(&insn_xchg_test1);
	report("xchg 1", 0, 1);

	exec_in_big_real_mode(&insn_xchg_test2);
	report("xchg 2", R_AX | R_BX,
	       outregs.eax == inregs.ebx && outregs.ebx == inregs.eax);

	exec_in_big_real_mode(&insn_xchg_test3);
	report("xchg 3", R_AX | R_CX,
	       outregs.eax == inregs.ecx && outregs.ecx == inregs.eax);

	exec_in_big_real_mode(&insn_xchg_test4);
	report("xchg 4", R_AX | R_DX,
	       outregs.eax == inregs.edx && outregs.edx == inregs.eax);

	exec_in_big_real_mode(&insn_xchg_test5);
	report("xchg 5", R_AX | R_SI,
	       outregs.eax == inregs.esi && outregs.esi == inregs.eax);

	exec_in_big_real_mode(&insn_xchg_test6);
	report("xchg 6", R_AX | R_DI,
	       outregs.eax == inregs.edi && outregs.edi == inregs.eax);

	exec_in_big_real_mode(&insn_xchg_test7);
	report("xchg 7", R_AX | R_BP,
	       outregs.eax == inregs.ebp && outregs.ebp == inregs.eax);

	exec_in_big_real_mode(&insn_xchg_test8);
	report("xchg 8", R_AX | R_SP,
	       outregs.eax == inregs.esp && outregs.esp == inregs.eax);
}

void test_shld(void)
{
	MK_INSN(shld_test, "shld $8,%edx,%eax\n\t");

	inregs = (struct regs){ .eax = 0xbe, .edx = 0xef000000 };
	exec_in_big_real_mode(&insn_shld_test);
	report("shld", ~0, outregs.eax == 0xbeef);
}

void test_mov_imm(void)
{
	MK_INSN(mov_r32_imm_1, "mov $1234567890, %eax");
	MK_INSN(mov_r16_imm_1, "mov $1234, %ax");
	MK_INSN(mov_r8_imm_1, "mov $0x12, %ah");
	MK_INSN(mov_r8_imm_2, "mov $0x34, %al");
	MK_INSN(mov_r8_imm_3, "mov $0x12, %ah\n\t" "mov $0x34, %al\n\t");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_mov_r16_imm_1);
	report("mov 1", R_AX, outregs.eax == 1234);

	/* test mov $imm, %eax */
	exec_in_big_real_mode(&insn_mov_r32_imm_1);
	report("mov 2", R_AX, outregs.eax == 1234567890);

	/* test mov $imm, %al/%ah */
	exec_in_big_real_mode(&insn_mov_r8_imm_1);
	report("mov 3", R_AX, outregs.eax == 0x1200);

	exec_in_big_real_mode(&insn_mov_r8_imm_2);
	report("mov 4", R_AX, outregs.eax == 0x34);

	exec_in_big_real_mode(&insn_mov_r8_imm_3);
	report("mov 5", R_AX, outregs.eax == 0x1234);
}

void test_sub_imm(void)
{
	MK_INSN(sub_r32_imm_1, "mov $1234567890, %eax\n\t" "sub $10, %eax\n\t");
	MK_INSN(sub_r16_imm_1, "mov $1234, %ax\n\t" "sub $10, %ax\n\t");
	MK_INSN(sub_r8_imm_1, "mov $0x12, %ah\n\t" "sub $0x10, %ah\n\t");
	MK_INSN(sub_r8_imm_2, "mov $0x34, %al\n\t" "sub $0x10, %al\n\t");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_sub_r16_imm_1);
	report("sub 1", R_AX, outregs.eax == 1224);

	/* test mov $imm, %eax */
	exec_in_big_real_mode(&insn_sub_r32_imm_1);
	report("sub 2", R_AX, outregs.eax == 1234567880);

	/* test mov $imm, %al/%ah */
	exec_in_big_real_mode(&insn_sub_r8_imm_1);
	report("sub 3", R_AX, outregs.eax == 0x0200);

	exec_in_big_real_mode(&insn_sub_r8_imm_2);
	report("sub 4", R_AX, outregs.eax == 0x24);
}

void test_xor_imm(void)
{
	MK_INSN(xor_r32_imm_1, "mov $1234567890, %eax\n\t" "xor $1234567890, %eax\n\t");
	MK_INSN(xor_r16_imm_1, "mov $1234, %ax\n\t" "xor $1234, %ax\n\t");
	MK_INSN(xor_r8_imm_1, "mov $0x12, %ah\n\t" "xor $0x12, %ah\n\t");
	MK_INSN(xor_r8_imm_2, "mov $0x34, %al\n\t" "xor $0x34, %al\n\t");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_xor_r16_imm_1);
	report("xor 1", R_AX, outregs.eax == 0);

	/* test mov $imm, %eax */
	exec_in_big_real_mode(&insn_xor_r32_imm_1);
	report("xor 2", R_AX, outregs.eax == 0);

	/* test mov $imm, %al/%ah */
	exec_in_big_real_mode(&insn_xor_r8_imm_1);
	report("xor 3", R_AX, outregs.eax == 0);

	exec_in_big_real_mode(&insn_xor_r8_imm_2);
	report("xor 4", R_AX, outregs.eax == 0);
}

void test_cmp_imm(void)
{
	MK_INSN(cmp_test1, "mov $0x34, %al\n\t"
			   "cmp $0x34, %al\n\t");
	MK_INSN(cmp_test2, "mov $0x34, %al\n\t"
			   "cmp $0x39, %al\n\t");
	MK_INSN(cmp_test3, "mov $0x34, %al\n\t"
			   "cmp $0x24, %al\n\t");

	inregs = (struct regs){ 0 };

	/* test cmp imm8 with AL */
	/* ZF: (bit 6) Zero Flag becomes 1 if an operation results
	 * in a 0 writeback, or 0 register
	 */
	exec_in_big_real_mode(&insn_cmp_test1);
	report("cmp 1", ~0, (outregs.eflags & (1<<6)) == (1<<6));

	exec_in_big_real_mode(&insn_cmp_test2);
	report("cmp 2", ~0, (outregs.eflags & (1<<6)) == 0);

	exec_in_big_real_mode(&insn_cmp_test3);
	report("cmp 3", ~0, (outregs.eflags & (1<<6)) == 0);
}

void test_add_imm(void)
{
	MK_INSN(add_test1, "mov $0x43211234, %eax \n\t"
			   "add $0x12344321, %eax \n\t");
	MK_INSN(add_test2, "mov $0x12, %eax \n\t"
			   "add $0x21, %al\n\t");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_add_test1);
	report("add 1", ~0, outregs.eax == 0x55555555);

	exec_in_big_real_mode(&insn_add_test2);
	report("add 2", ~0, outregs.eax == 0x33);
}

void test_eflags_insn(void)
{
	MK_INSN(clc, "clc");
	MK_INSN(stc, "stc");
	MK_INSN(cli, "cli");
	MK_INSN(sti, "sti");
	MK_INSN(cld, "cld");
	MK_INSN(std, "std");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_clc);
	report("clc", ~0, (outregs.eflags & 1) == 0);

	exec_in_big_real_mode(&insn_stc);
	report("stc", ~0, (outregs.eflags & 1) == 1);

	exec_in_big_real_mode(&insn_cli);
	report("cli", ~0, !(outregs.eflags & (1 << 9)));

	exec_in_big_real_mode(&insn_sti);
	report("sti", ~0, outregs.eflags & (1 << 9));

	exec_in_big_real_mode(&insn_cld);
	report("cld", ~0, !(outregs.eflags & (1 << 10)));

	exec_in_big_real_mode(&insn_std);
	report("std", ~0, (outregs.eflags & (1 << 10)));
}

void test_io(void)
{
	MK_INSN(io_test1, "mov $0xff, %al \n\t"
		          "out %al, $0xe0 \n\t"
		          "mov $0x00, %al \n\t"
			  "in $0xe0, %al \n\t");
	MK_INSN(io_test2, "mov $0xffff, %ax \n\t"
			  "out %ax, $0xe0 \n\t"
			  "mov $0x0000, %ax \n\t"
			  "in $0xe0, %ax \n\t");
	MK_INSN(io_test3, "mov $0xffffffff, %eax \n\t"
			  "out %eax, $0xe0 \n\t"
			  "mov $0x000000, %eax \n\t"
			  "in $0xe0, %eax \n\t");
	MK_INSN(io_test4, "mov $0xe0, %dx \n\t"
			  "mov $0xff, %al \n\t"
			  "out %al, %dx \n\t"
			  "mov $0x00, %al \n\t"
			  "in %dx, %al \n\t");
	MK_INSN(io_test5, "mov $0xe0, %dx \n\t"
			  "mov $0xffff, %ax \n\t"
			  "out %ax, %dx \n\t"
			  "mov $0x0000, %ax \n\t"
			  "in %dx, %ax \n\t");
	MK_INSN(io_test6, "mov $0xe0, %dx \n\t"
			  "mov $0xffffffff, %eax \n\t"
			  "out %eax, %dx \n\t"
			  "mov $0x00000000, %eax \n\t"
			  "in %dx, %eax \n\t");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_io_test1);
	report("pio 1", R_AX, outregs.eax == 0xff);

	exec_in_big_real_mode(&insn_io_test2);
	report("pio 2", R_AX, outregs.eax == 0xffff);

	exec_in_big_real_mode(&insn_io_test3);
	report("pio 3", R_AX, outregs.eax == 0xffffffff);

	exec_in_big_real_mode(&insn_io_test4);
	report("pio 4", R_AX|R_DX, outregs.eax == 0xff);

	exec_in_big_real_mode(&insn_io_test5);
	report("pio 5", R_AX|R_DX, outregs.eax == 0xffff);

	exec_in_big_real_mode(&insn_io_test6);
	report("pio 6", R_AX|R_DX, outregs.eax == 0xffffffff);
}

asm ("retf: lretw");
extern void retf();

asm ("retf_imm: lretw $10");
extern void retf_imm();

void test_call(void)
{
	u32 esp[16];
	u32 addr;

	inregs = (struct regs){ 0 };
	inregs.esp = (u32)esp;

	MK_INSN(call1, "mov $test_function, %eax \n\t"
		       "call *%eax\n\t");
	MK_INSN(call_near1, "jmp 2f\n\t"
			    "1: mov $0x1234, %eax\n\t"
			    "ret\n\t"
			    "2: call 1b\t");
	MK_INSN(call_near2, "call 1f\n\t"
			    "jmp 2f\n\t"
			    "1: mov $0x1234, %eax\n\t"
			    "ret\n\t"
			    "2:\t");
	MK_INSN(call_far1,  "lcallw *(%ebx)\n\t");
	MK_INSN(call_far2,  "lcallw $0, $retf\n\t");
	MK_INSN(ret_imm,    "sub $10, %sp; jmp 2f; 1: retw $10; 2: callw 1b");
	MK_INSN(retf_imm,   "sub $10, %sp; lcallw $0, $retf_imm");

	exec_in_big_real_mode(&insn_call1);
	report("call 1", R_AX, outregs.eax == 0x1234);

	exec_in_big_real_mode(&insn_call_near1);
	report("call near 1", R_AX, outregs.eax == 0x1234);

	exec_in_big_real_mode(&insn_call_near2);
	report("call near 2", R_AX, outregs.eax == 0x1234);

	addr = (((unsigned)retf >> 4) << 16) | ((unsigned)retf & 0x0f);
	inregs.ebx = (unsigned)&addr;
	exec_in_big_real_mode(&insn_call_far1);
	report("call far 1", 0, 1);

	exec_in_big_real_mode(&insn_call_far2);
	report("call far 2", 0, 1);

	exec_in_big_real_mode(&insn_ret_imm);
	report("ret imm 1", 0, 1);

	exec_in_big_real_mode(&insn_retf_imm);
	report("retf imm 1", 0, 1);
}

void test_jcc_short(void)
{
	MK_INSN(jnz_short1, "jnz 1f\n\t"
			    "mov $0x1234, %eax\n\t"
		            "1:\n\t");
	MK_INSN(jnz_short2, "1:\n\t"
			    "cmp $0x1234, %eax\n\t"
			    "mov $0x1234, %eax\n\t"
		            "jnz 1b\n\t");
	MK_INSN(jmp_short1, "jmp 1f\n\t"
		      "mov $0x1234, %eax\n\t"
		      "1:\n\t");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_jnz_short1);
	report("jnz short 1", ~0, 1);

	exec_in_big_real_mode(&insn_jnz_short2);
	report("jnz short 2", R_AX, (outregs.eflags & (1 << 6)));

	exec_in_big_real_mode(&insn_jmp_short1);
	report("jmp short 1", ~0, 1);
}

void test_jcc_near(void)
{
	/* encode near jmp manually. gas will not do it if offsets < 127 byte */
	MK_INSN(jnz_near1, ".byte 0x0f, 0x85, 0x06, 0x00\n\t"
		           "mov $0x1234, %eax\n\t");
	MK_INSN(jnz_near2, "cmp $0x1234, %eax\n\t"
			   "mov $0x1234, %eax\n\t"
		           ".byte 0x0f, 0x85, 0xf0, 0xff\n\t");
	MK_INSN(jmp_near1, ".byte 0xE9, 0x06, 0x00\n\t"
		           "mov $0x1234, %eax\n\t");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_jnz_near1);
	report("jnz near 1", 0, 1);

	exec_in_big_real_mode(&insn_jnz_near2);
	report("jnz near 2", R_AX, outregs.eflags & (1 << 6));

	exec_in_big_real_mode(&insn_jmp_near1);
	report("jmp near 1", 0, 1);
}

void test_long_jmp()
{
	u32 esp[16];

	inregs = (struct regs){ 0 };
	inregs.esp = (u32)(esp+16);
	MK_INSN(long_jmp, "call 1f\n\t"
			  "jmp 2f\n\t"
			  "1: jmp $0, $test_function\n\t"
		          "2:\n\t");
	exec_in_big_real_mode(&insn_long_jmp);
	report("jmp far 1", R_AX, outregs.eax == 0x1234);
}

void test_push_pop()
{
	MK_INSN(push32, "mov $0x12345678, %eax\n\t"
			"push %eax\n\t"
			"pop %ebx\n\t");
	MK_INSN(push16, "mov $0x1234, %ax\n\t"
			"push %ax\n\t"
			"pop %bx\n\t");

	MK_INSN(push_es, "mov $0x231, %bx\n\t" //Just write a dummy value to see if it gets overwritten
			 "mov $0x123, %ax\n\t"
			 "mov %ax, %es\n\t"
			 "push %es\n\t"
			 "pop %bx \n\t"
			 );
	MK_INSN(pop_es, "push %ax\n\t"
			"pop %es\n\t"
			"mov %es, %bx\n\t"
			);
	MK_INSN(push_pop_ss, "push %ss\n\t"
			     "pushw %ax\n\t"
			     "popw %ss\n\t"
			     "mov %ss, %bx\n\t"
			     "pop %ss\n\t"
			);
	MK_INSN(push_pop_fs, "push %fs\n\t"
			     "pushl %eax\n\t"
			     "popl %fs\n\t"
			     "mov %fs, %ebx\n\t"
			     "pop %fs\n\t"
			);
	MK_INSN(push_pop_high_esp_bits,
		"xor $0x12340000, %esp \n\t"
		"push %ax; \n\t"
		"xor $0x12340000, %esp \n\t"
		"pop %bx");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_push32);
	report("push/pop 1", R_AX|R_BX,
	       outregs.eax == outregs.ebx && outregs.eax == 0x12345678);

	exec_in_big_real_mode(&insn_push16);
	report("push/pop 2", R_AX|R_BX,
	       outregs.eax == outregs.ebx && outregs.eax == 0x1234);

	exec_in_big_real_mode(&insn_push_es);
	report("push/pop 3", R_AX|R_BX,
	       outregs.ebx == outregs.eax && outregs.eax == 0x123);

	exec_in_big_real_mode(&insn_pop_es);
	report("push/pop 4", R_AX|R_BX, outregs.ebx == outregs.eax);

	exec_in_big_real_mode(&insn_push_pop_ss);
	report("push/pop 5", R_AX|R_BX, outregs.ebx == outregs.eax);

	exec_in_big_real_mode(&insn_push_pop_fs);
	report("push/pop 6", R_AX|R_BX, outregs.ebx == outregs.eax);

	inregs.eax = 0x9977;
	inregs.ebx = 0x7799;
	exec_in_big_real_mode(&insn_push_pop_high_esp_bits);
	report("push/pop with high bits set in %esp", R_BX, outregs.ebx == 0x9977);
}

void test_null(void)
{
	MK_INSN(null, "");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_null);
	report("null", 0, 1);
}

struct {
    char stack[500];
    char top[];
} tmp_stack;

void test_pusha_popa()
{
	MK_INSN(pusha, "pusha\n\t"
		       "pop %edi\n\t"
		       "pop %esi\n\t"
		       "pop %ebp\n\t"
		       "add $4, %esp\n\t"
		       "pop %ebx\n\t"
		       "pop %edx\n\t"
		       "pop %ecx\n\t"
		       "pop %eax\n\t"
		       );

	MK_INSN(popa, "push %eax\n\t"
		      "push %ecx\n\t"
		      "push %edx\n\t"
		      "push %ebx\n\t"
		      "push %esp\n\t"
		      "push %ebp\n\t"
		      "push %esi\n\t"
		      "push %edi\n\t"
		      "popa\n\t"
		      );

	inregs = (struct regs){ .eax = 0, .ebx = 1, .ecx = 2, .edx = 3, .esi = 4, .edi = 5, .ebp = 6, .esp = (unsigned long)&tmp_stack.top };

	exec_in_big_real_mode(&insn_pusha);
	report("pusha/popa 1", 0, 1);

	exec_in_big_real_mode(&insn_popa);
	report("pusha/popa 1", 0, 1);
}

void test_iret()
{
	MK_INSN(iret32, "pushf\n\t"
			"pushl %cs\n\t"
			"call 1f\n\t" /* a near call will push eip onto the stack */
			"jmp 2f\n\t"
			"1: iret\n\t"
			"2:\n\t"
		     );

	MK_INSN(iret16, "pushfw\n\t"
			"pushw %cs\n\t"
			"callw 1f\n\t"
			"jmp 2f\n\t"
			"1: iretw\n\t"
			"2:\n\t");

	MK_INSN(iret_flags32, "pushfl\n\t"
			      "popl %eax\n\t"
			      "andl $~0x2, %eax\n\t"
			      "orl $0xffc18028, %eax\n\t"
			      "pushl %eax\n\t"
			      "pushl %cs\n\t"
			      "call 1f\n\t"
			      "jmp 2f\n\t"
			      "1: iret\n\t"
			      "2:\n\t");

	MK_INSN(iret_flags16, "pushfw\n\t"
			      "popw %ax\n\t"
			      "and $~0x2, %ax\n\t"
			      "or $0x8028, %ax\n\t"
			      "pushw %ax\n\t"
			      "pushw %cs\n\t"
			      "callw 1f\n\t"
			      "jmp 2f\n\t"
			      "1: iretw\n\t"
			      "2:\n\t");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_iret32);
	report("iret 1", 0, 1);

	exec_in_big_real_mode(&insn_iret16);
	report("iret 2", 0, 1);

	exec_in_big_real_mode(&insn_iret_flags32);
	report("iret 3", R_AX, 1);
	report("rflags.rf", ~0, !(outregs.eflags & (1 << 16)));

	exec_in_big_real_mode(&insn_iret_flags16);
	report("iret 4", R_AX, 1);
}

void test_int()
{
	inregs = (struct regs){ 0 };

	*(u32 *)(0x11 * 4) = 0x1000; /* Store a pointer to address 0x1000 in IDT entry 0x11 */
	*(u8 *)(0x1000) = 0xcf; /* 0x1000 contains an IRET instruction */

	MK_INSN(int11, "int $0x11\n\t");

	exec_in_big_real_mode(&insn_int11);
	report("int 1", 0, 1);
}

void test_imul()
{
	MK_INSN(imul8_1, "mov $2, %al\n\t"
			"mov $-4, %cx\n\t"
			"imul %cl\n\t");

	MK_INSN(imul16_1, "mov $2, %ax\n\t"
		      "mov $-4, %cx\n\t"
		      "imul %cx\n\t");

	MK_INSN(imul32_1, "mov $2, %eax\n\t"
		       "mov $-4, %ecx\n\t"
		       "imul %ecx\n\t");

	MK_INSN(imul8_2, "mov $0x12340002, %eax\n\t"
			"mov $4, %cx\n\t"
			"imul %cl\n\t");

	MK_INSN(imul16_2, "mov $2, %ax\n\t"
			"mov $4, %cx\n\t"
			"imul %cx\n\t");

	MK_INSN(imul32_2, "mov $2, %eax\n\t"
			"mov $4, %ecx\n\t"
			"imul %ecx\n\t");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_imul8_1);
	report("imul 1", R_AX | R_CX | R_DX, (outregs.eax & 0xff) == (u8)-8);

	exec_in_big_real_mode(&insn_imul16_1);
	report("imul 2", R_AX | R_CX | R_DX, outregs.eax == (u16)-8);

	exec_in_big_real_mode(&insn_imul32_1);
	report("imul 3", R_AX | R_CX | R_DX, outregs.eax == (u32)-8);

	exec_in_big_real_mode(&insn_imul8_2);
	report("imul 4", R_AX | R_CX | R_DX,
	       (outregs.eax & 0xffff) == 8
	       && (outregs.eax & 0xffff0000) == 0x12340000);

	exec_in_big_real_mode(&insn_imul16_2);
	report("imul 5", R_AX | R_CX | R_DX, outregs.eax == 8);

	exec_in_big_real_mode(&insn_imul32_2);
	report("imul 6", R_AX | R_CX | R_DX, outregs.eax == 8);
}

void test_mul()
{
	MK_INSN(mul8, "mov $2, %al\n\t"
			"mov $4, %cx\n\t"
			"imul %cl\n\t");

	MK_INSN(mul16, "mov $2, %ax\n\t"
			"mov $4, %cx\n\t"
			"imul %cx\n\t");

	MK_INSN(mul32, "mov $2, %eax\n\t"
			"mov $4, %ecx\n\t"
			"imul %ecx\n\t");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_mul8);
	report("mul 1", R_AX | R_CX | R_DX, (outregs.eax & 0xff) == 8);

	exec_in_big_real_mode(&insn_mul16);
	report("mul 2", R_AX | R_CX | R_DX, outregs.eax == 8);

	exec_in_big_real_mode(&insn_mul32);
	report("mul 3", R_AX | R_CX | R_DX, outregs.eax == 8);
}

void test_div()
{
	MK_INSN(div8, "mov $257, %ax\n\t"
			"mov $2, %cl\n\t"
			"div %cl\n\t");

	MK_INSN(div16, "mov $512, %ax\n\t"
			"mov $5, %cx\n\t"
			"div %cx\n\t");

	MK_INSN(div32, "mov $512, %eax\n\t"
			"mov $5, %ecx\n\t"
			"div %ecx\n\t");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_div8);
	report("div 1", R_AX | R_CX | R_DX, outregs.eax == 384);

	exec_in_big_real_mode(&insn_div16);
	report("div 2", R_AX | R_CX | R_DX,
	       outregs.eax == 102 && outregs.edx == 2);

	exec_in_big_real_mode(&insn_div32);
	report("div 3", R_AX | R_CX | R_DX,
	       outregs.eax == 102 && outregs.edx == 2);
}

void test_idiv()
{
	MK_INSN(idiv8, "mov $256, %ax\n\t"
			"mov $-2, %cl\n\t"
			"idiv %cl\n\t");

	MK_INSN(idiv16, "mov $512, %ax\n\t"
			"mov $-2, %cx\n\t"
			"idiv %cx\n\t");

	MK_INSN(idiv32, "mov $512, %eax\n\t"
			"mov $-2, %ecx\n\t"
			"idiv %ecx\n\t");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_idiv8);
	report("idiv 1", R_AX | R_CX | R_DX, outregs.eax == (u8)-128);

	exec_in_big_real_mode(&insn_idiv16);
	report("idiv 2", R_AX | R_CX | R_DX, outregs.eax == (u16)-256);

	exec_in_big_real_mode(&insn_idiv32);
	report("idiv 3", R_AX | R_CX | R_DX, outregs.eax == (u32)-256);
}

void test_cbw(void)
{
	MK_INSN(cbw, "mov $0xFE, %eax \n\t"
		     "cbw\n\t");
	MK_INSN(cwde, "mov $0xFFFE, %eax \n\t"
		      "cwde\n\t");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_cbw);
	report("cbq 1", ~0, outregs.eax == 0xFFFE);

	exec_in_big_real_mode(&insn_cwde);
	report("cwde 1", ~0, outregs.eax == 0xFFFFFFFE);
}

void test_loopcc(void)
{
	MK_INSN(loop, "mov $10, %ecx\n\t"
		      "1: inc %eax\n\t"
		      "loop 1b\n\t");

	MK_INSN(loope, "mov $10, %ecx\n\t"
		       "mov $1, %eax\n\t"
		       "1: dec %eax\n\t"
		       "loope 1b\n\t");

	MK_INSN(loopne, "mov $10, %ecx\n\t"
		        "mov $5, %eax\n\t"
		        "1: dec %eax\n\t"
			"loopne 1b\n\t");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_loop);
	report("LOOPcc short 1", R_AX, outregs.eax == 10);

	exec_in_big_real_mode(&insn_loope);
	report("LOOPcc short 2", R_AX | R_CX,
	       outregs.eax == -1 && outregs.ecx == 8);

	exec_in_big_real_mode(&insn_loopne);
	report("LOOPcc short 3", R_AX | R_CX,
	       outregs.eax == 0 && outregs.ecx == 5);
}

static void test_das(void)
{
    short i;
    u16 nr_fail = 0;
    static unsigned test_cases[1024] = {
        0x46000000, 0x8701a000, 0x9710fa00, 0x97119a00,
        0x02000101, 0x8301a101, 0x9310fb01, 0x93119b01,
        0x02000202, 0x8301a202, 0x9710fc02, 0x97119c02,
        0x06000303, 0x8701a303, 0x9310fd03, 0x93119d03,
        0x02000404, 0x8301a404, 0x9310fe04, 0x93119e04,
        0x06000505, 0x8701a505, 0x9710ff05, 0x97119f05,
        0x06000606, 0x8701a606, 0x56100006, 0x9711a006,
        0x02000707, 0x8301a707, 0x12100107, 0x9311a107,
        0x02000808, 0x8301a808, 0x12100208, 0x9311a208,
        0x06000909, 0x8701a909, 0x16100309, 0x9711a309,
        0x1200040a, 0x9301a40a, 0x1210040a, 0x9311a40a,
        0x1600050b, 0x9701a50b, 0x1610050b, 0x9711a50b,
        0x1600060c, 0x9701a60c, 0x1610060c, 0x9711a60c,
        0x1200070d, 0x9301a70d, 0x1210070d, 0x9311a70d,
        0x1200080e, 0x9301a80e, 0x1210080e, 0x9311a80e,
        0x1600090f, 0x9701a90f, 0x1610090f, 0x9711a90f,
        0x02001010, 0x8301b010, 0x16100a10, 0x9711aa10,
        0x06001111, 0x8701b111, 0x12100b11, 0x9311ab11,
        0x06001212, 0x8701b212, 0x16100c12, 0x9711ac12,
        0x02001313, 0x8301b313, 0x12100d13, 0x9311ad13,
        0x06001414, 0x8701b414, 0x12100e14, 0x9311ae14,
        0x02001515, 0x8301b515, 0x16100f15, 0x9711af15,
        0x02001616, 0x8301b616, 0x12101016, 0x9311b016,
        0x06001717, 0x8701b717, 0x16101117, 0x9711b117,
        0x06001818, 0x8701b818, 0x16101218, 0x9711b218,
        0x02001919, 0x8301b919, 0x12101319, 0x9311b319,
        0x1600141a, 0x9701b41a, 0x1610141a, 0x9711b41a,
        0x1200151b, 0x9301b51b, 0x1210151b, 0x9311b51b,
        0x1200161c, 0x9301b61c, 0x1210161c, 0x9311b61c,
        0x1600171d, 0x9701b71d, 0x1610171d, 0x9711b71d,
        0x1600181e, 0x9701b81e, 0x1610181e, 0x9711b81e,
        0x1200191f, 0x9301b91f, 0x1210191f, 0x9311b91f,
        0x02002020, 0x8701c020, 0x12101a20, 0x9311ba20,
        0x06002121, 0x8301c121, 0x16101b21, 0x9711bb21,
        0x06002222, 0x8301c222, 0x12101c22, 0x9311bc22,
        0x02002323, 0x8701c323, 0x16101d23, 0x9711bd23,
        0x06002424, 0x8301c424, 0x16101e24, 0x9711be24,
        0x02002525, 0x8701c525, 0x12101f25, 0x9311bf25,
        0x02002626, 0x8701c626, 0x12102026, 0x9711c026,
        0x06002727, 0x8301c727, 0x16102127, 0x9311c127,
        0x06002828, 0x8301c828, 0x16102228, 0x9311c228,
        0x02002929, 0x8701c929, 0x12102329, 0x9711c329,
        0x1600242a, 0x9301c42a, 0x1610242a, 0x9311c42a,
        0x1200252b, 0x9701c52b, 0x1210252b, 0x9711c52b,
        0x1200262c, 0x9701c62c, 0x1210262c, 0x9711c62c,
        0x1600272d, 0x9301c72d, 0x1610272d, 0x9311c72d,
        0x1600282e, 0x9301c82e, 0x1610282e, 0x9311c82e,
        0x1200292f, 0x9701c92f, 0x1210292f, 0x9711c92f,
        0x06003030, 0x8301d030, 0x12102a30, 0x9711ca30,
        0x02003131, 0x8701d131, 0x16102b31, 0x9311cb31,
        0x02003232, 0x8701d232, 0x12102c32, 0x9711cc32,
        0x06003333, 0x8301d333, 0x16102d33, 0x9311cd33,
        0x02003434, 0x8701d434, 0x16102e34, 0x9311ce34,
        0x06003535, 0x8301d535, 0x12102f35, 0x9711cf35,
        0x06003636, 0x8301d636, 0x16103036, 0x9311d036,
        0x02003737, 0x8701d737, 0x12103137, 0x9711d137,
        0x02003838, 0x8701d838, 0x12103238, 0x9711d238,
        0x06003939, 0x8301d939, 0x16103339, 0x9311d339,
        0x1200343a, 0x9701d43a, 0x1210343a, 0x9711d43a,
        0x1600353b, 0x9301d53b, 0x1610353b, 0x9311d53b,
        0x1600363c, 0x9301d63c, 0x1610363c, 0x9311d63c,
        0x1200373d, 0x9701d73d, 0x1210373d, 0x9711d73d,
        0x1200383e, 0x9701d83e, 0x1210383e, 0x9711d83e,
        0x1600393f, 0x9301d93f, 0x1610393f, 0x9311d93f,
        0x02004040, 0x8301e040, 0x16103a40, 0x9311da40,
        0x06004141, 0x8701e141, 0x12103b41, 0x9711db41,
        0x06004242, 0x8701e242, 0x16103c42, 0x9311dc42,
        0x02004343, 0x8301e343, 0x12103d43, 0x9711dd43,
        0x06004444, 0x8701e444, 0x12103e44, 0x9711de44,
        0x02004545, 0x8301e545, 0x16103f45, 0x9311df45,
        0x02004646, 0x8301e646, 0x12104046, 0x9311e046,
        0x06004747, 0x8701e747, 0x16104147, 0x9711e147,
        0x06004848, 0x8701e848, 0x16104248, 0x9711e248,
        0x02004949, 0x8301e949, 0x12104349, 0x9311e349,
        0x1600444a, 0x9701e44a, 0x1610444a, 0x9711e44a,
        0x1200454b, 0x9301e54b, 0x1210454b, 0x9311e54b,
        0x1200464c, 0x9301e64c, 0x1210464c, 0x9311e64c,
        0x1600474d, 0x9701e74d, 0x1610474d, 0x9711e74d,
        0x1600484e, 0x9701e84e, 0x1610484e, 0x9711e84e,
        0x1200494f, 0x9301e94f, 0x1210494f, 0x9311e94f,
        0x06005050, 0x8701f050, 0x12104a50, 0x9311ea50,
        0x02005151, 0x8301f151, 0x16104b51, 0x9711eb51,
        0x02005252, 0x8301f252, 0x12104c52, 0x9311ec52,
        0x06005353, 0x8701f353, 0x16104d53, 0x9711ed53,
        0x02005454, 0x8301f454, 0x16104e54, 0x9711ee54,
        0x06005555, 0x8701f555, 0x12104f55, 0x9311ef55,
        0x06005656, 0x8701f656, 0x16105056, 0x9711f056,
        0x02005757, 0x8301f757, 0x12105157, 0x9311f157,
        0x02005858, 0x8301f858, 0x12105258, 0x9311f258,
        0x06005959, 0x8701f959, 0x16105359, 0x9711f359,
        0x1200545a, 0x9301f45a, 0x1210545a, 0x9311f45a,
        0x1600555b, 0x9701f55b, 0x1610555b, 0x9711f55b,
        0x1600565c, 0x9701f65c, 0x1610565c, 0x9711f65c,
        0x1200575d, 0x9301f75d, 0x1210575d, 0x9311f75d,
        0x1200585e, 0x9301f85e, 0x1210585e, 0x9311f85e,
        0x1600595f, 0x9701f95f, 0x1610595f, 0x9711f95f,
        0x06006060, 0x47010060, 0x16105a60, 0x9711fa60,
        0x02006161, 0x03010161, 0x12105b61, 0x9311fb61,
        0x02006262, 0x03010262, 0x16105c62, 0x9711fc62,
        0x06006363, 0x07010363, 0x12105d63, 0x9311fd63,
        0x02006464, 0x03010464, 0x12105e64, 0x9311fe64,
        0x06006565, 0x07010565, 0x16105f65, 0x9711ff65,
        0x06006666, 0x07010666, 0x16106066, 0x57110066,
        0x02006767, 0x03010767, 0x12106167, 0x13110167,
        0x02006868, 0x03010868, 0x12106268, 0x13110268,
        0x06006969, 0x07010969, 0x16106369, 0x17110369,
        0x1200646a, 0x1301046a, 0x1210646a, 0x1311046a,
        0x1600656b, 0x1701056b, 0x1610656b, 0x1711056b,
        0x1600666c, 0x1701066c, 0x1610666c, 0x1711066c,
        0x1200676d, 0x1301076d, 0x1210676d, 0x1311076d,
        0x1200686e, 0x1301086e, 0x1210686e, 0x1311086e,
        0x1600696f, 0x1701096f, 0x1610696f, 0x1711096f,
        0x02007070, 0x03011070, 0x16106a70, 0x17110a70,
        0x06007171, 0x07011171, 0x12106b71, 0x13110b71,
        0x06007272, 0x07011272, 0x16106c72, 0x17110c72,
        0x02007373, 0x03011373, 0x12106d73, 0x13110d73,
        0x06007474, 0x07011474, 0x12106e74, 0x13110e74,
        0x02007575, 0x03011575, 0x16106f75, 0x17110f75,
        0x02007676, 0x03011676, 0x12107076, 0x13111076,
        0x06007777, 0x07011777, 0x16107177, 0x17111177,
        0x06007878, 0x07011878, 0x16107278, 0x17111278,
        0x02007979, 0x03011979, 0x12107379, 0x13111379,
        0x1600747a, 0x1701147a, 0x1610747a, 0x1711147a,
        0x1200757b, 0x1301157b, 0x1210757b, 0x1311157b,
        0x1200767c, 0x1301167c, 0x1210767c, 0x1311167c,
        0x1600777d, 0x1701177d, 0x1610777d, 0x1711177d,
        0x1600787e, 0x1701187e, 0x1610787e, 0x1711187e,
        0x1200797f, 0x1301197f, 0x1210797f, 0x1311197f,
        0x82008080, 0x03012080, 0x12107a80, 0x13111a80,
        0x86008181, 0x07012181, 0x16107b81, 0x17111b81,
        0x86008282, 0x07012282, 0x12107c82, 0x13111c82,
        0x82008383, 0x03012383, 0x16107d83, 0x17111d83,
        0x86008484, 0x07012484, 0x16107e84, 0x17111e84,
        0x82008585, 0x03012585, 0x12107f85, 0x13111f85,
        0x82008686, 0x03012686, 0x92108086, 0x13112086,
        0x86008787, 0x07012787, 0x96108187, 0x17112187,
        0x86008888, 0x07012888, 0x96108288, 0x17112288,
        0x82008989, 0x03012989, 0x92108389, 0x13112389,
        0x9600848a, 0x1701248a, 0x9610848a, 0x1711248a,
        0x9200858b, 0x1301258b, 0x9210858b, 0x1311258b,
        0x9200868c, 0x1301268c, 0x9210868c, 0x1311268c,
        0x9600878d, 0x1701278d, 0x9610878d, 0x1711278d,
        0x9600888e, 0x1701288e, 0x9610888e, 0x1711288e,
        0x9200898f, 0x1301298f, 0x9210898f, 0x1311298f,
        0x86009090, 0x07013090, 0x92108a90, 0x13112a90,
        0x82009191, 0x03013191, 0x96108b91, 0x17112b91,
        0x82009292, 0x03013292, 0x92108c92, 0x13112c92,
        0x86009393, 0x07013393, 0x96108d93, 0x17112d93,
        0x82009494, 0x03013494, 0x96108e94, 0x17112e94,
        0x86009595, 0x07013595, 0x92108f95, 0x13112f95,
        0x86009696, 0x07013696, 0x96109096, 0x17113096,
        0x82009797, 0x03013797, 0x92109197, 0x13113197,
        0x82009898, 0x03013898, 0x92109298, 0x13113298,
        0x86009999, 0x07013999, 0x96109399, 0x17113399,
        0x1300349a, 0x1301349a, 0x1310349a, 0x1311349a,
        0x1700359b, 0x1701359b, 0x1710359b, 0x1711359b,
        0x1700369c, 0x1701369c, 0x1710369c, 0x1711369c,
        0x1300379d, 0x1301379d, 0x1310379d, 0x1311379d,
        0x1300389e, 0x1301389e, 0x1310389e, 0x1311389e,
        0x1700399f, 0x1701399f, 0x1710399f, 0x1711399f,
        0x030040a0, 0x030140a0, 0x17103aa0, 0x17113aa0,
        0x070041a1, 0x070141a1, 0x13103ba1, 0x13113ba1,
        0x070042a2, 0x070142a2, 0x17103ca2, 0x17113ca2,
        0x030043a3, 0x030143a3, 0x13103da3, 0x13113da3,
        0x070044a4, 0x070144a4, 0x13103ea4, 0x13113ea4,
        0x030045a5, 0x030145a5, 0x17103fa5, 0x17113fa5,
        0x030046a6, 0x030146a6, 0x131040a6, 0x131140a6,
        0x070047a7, 0x070147a7, 0x171041a7, 0x171141a7,
        0x070048a8, 0x070148a8, 0x171042a8, 0x171142a8,
        0x030049a9, 0x030149a9, 0x131043a9, 0x131143a9,
        0x170044aa, 0x170144aa, 0x171044aa, 0x171144aa,
        0x130045ab, 0x130145ab, 0x131045ab, 0x131145ab,
        0x130046ac, 0x130146ac, 0x131046ac, 0x131146ac,
        0x170047ad, 0x170147ad, 0x171047ad, 0x171147ad,
        0x170048ae, 0x170148ae, 0x171048ae, 0x171148ae,
        0x130049af, 0x130149af, 0x131049af, 0x131149af,
        0x070050b0, 0x070150b0, 0x13104ab0, 0x13114ab0,
        0x030051b1, 0x030151b1, 0x17104bb1, 0x17114bb1,
        0x030052b2, 0x030152b2, 0x13104cb2, 0x13114cb2,
        0x070053b3, 0x070153b3, 0x17104db3, 0x17114db3,
        0x030054b4, 0x030154b4, 0x17104eb4, 0x17114eb4,
        0x070055b5, 0x070155b5, 0x13104fb5, 0x13114fb5,
        0x070056b6, 0x070156b6, 0x171050b6, 0x171150b6,
        0x030057b7, 0x030157b7, 0x131051b7, 0x131151b7,
        0x030058b8, 0x030158b8, 0x131052b8, 0x131152b8,
        0x070059b9, 0x070159b9, 0x171053b9, 0x171153b9,
        0x130054ba, 0x130154ba, 0x131054ba, 0x131154ba,
        0x170055bb, 0x170155bb, 0x171055bb, 0x171155bb,
        0x170056bc, 0x170156bc, 0x171056bc, 0x171156bc,
        0x130057bd, 0x130157bd, 0x131057bd, 0x131157bd,
        0x130058be, 0x130158be, 0x131058be, 0x131158be,
        0x170059bf, 0x170159bf, 0x171059bf, 0x171159bf,
        0x070060c0, 0x070160c0, 0x17105ac0, 0x17115ac0,
        0x030061c1, 0x030161c1, 0x13105bc1, 0x13115bc1,
        0x030062c2, 0x030162c2, 0x17105cc2, 0x17115cc2,
        0x070063c3, 0x070163c3, 0x13105dc3, 0x13115dc3,
        0x030064c4, 0x030164c4, 0x13105ec4, 0x13115ec4,
        0x070065c5, 0x070165c5, 0x17105fc5, 0x17115fc5,
        0x070066c6, 0x070166c6, 0x171060c6, 0x171160c6,
        0x030067c7, 0x030167c7, 0x131061c7, 0x131161c7,
        0x030068c8, 0x030168c8, 0x131062c8, 0x131162c8,
        0x070069c9, 0x070169c9, 0x171063c9, 0x171163c9,
        0x130064ca, 0x130164ca, 0x131064ca, 0x131164ca,
        0x170065cb, 0x170165cb, 0x171065cb, 0x171165cb,
        0x170066cc, 0x170166cc, 0x171066cc, 0x171166cc,
        0x130067cd, 0x130167cd, 0x131067cd, 0x131167cd,
        0x130068ce, 0x130168ce, 0x131068ce, 0x131168ce,
        0x170069cf, 0x170169cf, 0x171069cf, 0x171169cf,
        0x030070d0, 0x030170d0, 0x17106ad0, 0x17116ad0,
        0x070071d1, 0x070171d1, 0x13106bd1, 0x13116bd1,
        0x070072d2, 0x070172d2, 0x17106cd2, 0x17116cd2,
        0x030073d3, 0x030173d3, 0x13106dd3, 0x13116dd3,
        0x070074d4, 0x070174d4, 0x13106ed4, 0x13116ed4,
        0x030075d5, 0x030175d5, 0x17106fd5, 0x17116fd5,
        0x030076d6, 0x030176d6, 0x131070d6, 0x131170d6,
        0x070077d7, 0x070177d7, 0x171071d7, 0x171171d7,
        0x070078d8, 0x070178d8, 0x171072d8, 0x171172d8,
        0x030079d9, 0x030179d9, 0x131073d9, 0x131173d9,
        0x170074da, 0x170174da, 0x171074da, 0x171174da,
        0x130075db, 0x130175db, 0x131075db, 0x131175db,
        0x130076dc, 0x130176dc, 0x131076dc, 0x131176dc,
        0x170077dd, 0x170177dd, 0x171077dd, 0x171177dd,
        0x170078de, 0x170178de, 0x171078de, 0x171178de,
        0x130079df, 0x130179df, 0x131079df, 0x131179df,
        0x830080e0, 0x830180e0, 0x13107ae0, 0x13117ae0,
        0x870081e1, 0x870181e1, 0x17107be1, 0x17117be1,
        0x870082e2, 0x870182e2, 0x13107ce2, 0x13117ce2,
        0x830083e3, 0x830183e3, 0x17107de3, 0x17117de3,
        0x870084e4, 0x870184e4, 0x17107ee4, 0x17117ee4,
        0x830085e5, 0x830185e5, 0x13107fe5, 0x13117fe5,
        0x830086e6, 0x830186e6, 0x931080e6, 0x931180e6,
        0x870087e7, 0x870187e7, 0x971081e7, 0x971181e7,
        0x870088e8, 0x870188e8, 0x971082e8, 0x971182e8,
        0x830089e9, 0x830189e9, 0x931083e9, 0x931183e9,
        0x970084ea, 0x970184ea, 0x971084ea, 0x971184ea,
        0x930085eb, 0x930185eb, 0x931085eb, 0x931185eb,
        0x930086ec, 0x930186ec, 0x931086ec, 0x931186ec,
        0x970087ed, 0x970187ed, 0x971087ed, 0x971187ed,
        0x970088ee, 0x970188ee, 0x971088ee, 0x971188ee,
        0x930089ef, 0x930189ef, 0x931089ef, 0x931189ef,
        0x870090f0, 0x870190f0, 0x93108af0, 0x93118af0,
        0x830091f1, 0x830191f1, 0x97108bf1, 0x97118bf1,
        0x830092f2, 0x830192f2, 0x93108cf2, 0x93118cf2,
        0x870093f3, 0x870193f3, 0x97108df3, 0x97118df3,
        0x830094f4, 0x830194f4, 0x97108ef4, 0x97118ef4,
        0x870095f5, 0x870195f5, 0x93108ff5, 0x93118ff5,
        0x870096f6, 0x870196f6, 0x971090f6, 0x971190f6,
        0x830097f7, 0x830197f7, 0x931091f7, 0x931191f7,
        0x830098f8, 0x830198f8, 0x931092f8, 0x931192f8,
        0x870099f9, 0x870199f9, 0x971093f9, 0x971193f9,
        0x930094fa, 0x930194fa, 0x931094fa, 0x931194fa,
        0x970095fb, 0x970195fb, 0x971095fb, 0x971195fb,
        0x970096fc, 0x970196fc, 0x971096fc, 0x971196fc,
        0x930097fd, 0x930197fd, 0x931097fd, 0x931197fd,
        0x930098fe, 0x930198fe, 0x931098fe, 0x931198fe,
        0x970099ff, 0x970199ff, 0x971099ff, 0x971199ff,
    };

    MK_INSN(das, "das");

    inregs = (struct regs){ 0 };

    for (i = 0; i < 1024; ++i) {
        unsigned tmp = test_cases[i];
        inregs.eax = tmp & 0xff;
        inregs.eflags = (tmp >> 16) & 0xff;
	exec_in_big_real_mode(&insn_das);
	if (!regs_equal(R_AX)
            || outregs.eax != ((tmp >> 8) & 0xff)
            || (outregs.eflags & 0xff) != (tmp >> 24)) {
	    ++nr_fail;
	    break;
        }
    }
    report("DAS", ~0, nr_fail == 0);
}

void test_cwd_cdq()
{
	/* Sign-bit set */
	MK_INSN(cwd_1, "mov $0x8000, %ax\n\t"
		       "cwd\n\t");

	/* Sign-bit not set */
	MK_INSN(cwd_2, "mov $0x1000, %ax\n\t"
		       "cwd\n\t");

	/* Sign-bit set */
	MK_INSN(cdq_1, "mov $0x80000000, %eax\n\t"
		       "cdq\n\t");

	/* Sign-bit not set */
	MK_INSN(cdq_2, "mov $0x10000000, %eax\n\t"
		       "cdq\n\t");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_cwd_1);
	report("cwd 1", R_AX | R_DX,
	       outregs.eax == 0x8000 && outregs.edx == 0xffff);

	exec_in_big_real_mode(&insn_cwd_2);
	report("cwd 2", R_AX | R_DX,
	       outregs.eax == 0x1000 && outregs.edx == 0);

	exec_in_big_real_mode(&insn_cdq_1);
	report("cdq 1", R_AX | R_DX,
	       outregs.eax == 0x80000000 && outregs.edx == 0xffffffff);

	exec_in_big_real_mode(&insn_cdq_2);
	report("cdq 2", R_AX | R_DX,
	       outregs.eax == 0x10000000 && outregs.edx == 0);
}

static struct {
        void *address;
        unsigned short sel;
} __attribute__((packed)) desc = {
	(void *)0x1234,
	0x10,
};

void test_lds_lss()
{
	inregs = (struct regs){ .ebx = (unsigned long)&desc };

	MK_INSN(lds, "push %ds\n\t"
		     "lds (%ebx), %eax\n\t"
		     "mov %ds, %ebx\n\t"
		     "pop %ds\n\t");
	exec_in_big_real_mode(&insn_lds);
	report("lds", R_AX | R_BX,
		outregs.eax == (unsigned long)desc.address &&
		outregs.ebx == desc.sel);

	MK_INSN(les, "push %es\n\t"
		     "les (%ebx), %eax\n\t"
		     "mov %es, %ebx\n\t"
		     "pop %es\n\t");
	exec_in_big_real_mode(&insn_les);
	report("les", R_AX | R_BX,
		outregs.eax == (unsigned long)desc.address &&
		outregs.ebx == desc.sel);

	MK_INSN(lfs, "push %fs\n\t"
		     "lfs (%ebx), %eax\n\t"
		     "mov %fs, %ebx\n\t"
		     "pop %fs\n\t");
	exec_in_big_real_mode(&insn_lfs);
	report("lfs", R_AX | R_BX,
		outregs.eax == (unsigned long)desc.address &&
		outregs.ebx == desc.sel);

	MK_INSN(lgs, "push %gs\n\t"
		     "lgs (%ebx), %eax\n\t"
		     "mov %gs, %ebx\n\t"
		     "pop %gs\n\t");
	exec_in_big_real_mode(&insn_lgs);
	report("lgs", R_AX | R_BX,
		outregs.eax == (unsigned long)desc.address &&
		outregs.ebx == desc.sel);

	MK_INSN(lss, "push %ss\n\t"
		     "lss (%ebx), %eax\n\t"
		     "mov %ss, %ebx\n\t"
		     "pop %ss\n\t");
	exec_in_big_real_mode(&insn_lss);
	report("lss", R_AX | R_BX,
		outregs.eax == (unsigned long)desc.address &&
		outregs.ebx == desc.sel);
}

void test_jcxz(void)
{
	MK_INSN(jcxz1, "jcxz 1f\n\t"
		       "mov $0x1234, %eax\n\t"
		       "1:\n\t");
	MK_INSN(jcxz2, "mov $0x100, %ecx\n\t"
		       "jcxz 1f\n\t"
		       "mov $0x1234, %eax\n\t"
		       "mov $0, %ecx\n\t"
		       "1:\n\t");
	MK_INSN(jcxz3, "mov $0x10000, %ecx\n\t"
		       "jcxz 1f\n\t"
		       "mov $0x1234, %eax\n\t"
		       "1:\n\t");
	MK_INSN(jecxz1, "jecxz 1f\n\t"
			"mov $0x1234, %eax\n\t"
			"1:\n\t");
	MK_INSN(jecxz2, "mov $0x10000, %ecx\n\t"
			"jecxz 1f\n\t"
			"mov $0x1234, %eax\n\t"
			"mov $0, %ecx\n\t"
			"1:\n\t");

	inregs = (struct regs){ 0 };

	exec_in_big_real_mode(&insn_jcxz1);
	report("jcxz short 1", 0, 1);

	exec_in_big_real_mode(&insn_jcxz2);
	report("jcxz short 2", R_AX, outregs.eax == 0x1234);

	exec_in_big_real_mode(&insn_jcxz3);
	report("jcxz short 3", R_CX, outregs.ecx == 0x10000);

	exec_in_big_real_mode(&insn_jecxz1);
	report("jecxz short 1", 0, 1);

	exec_in_big_real_mode(&insn_jecxz2);
	report("jecxz short 2", R_AX, outregs.eax == 0x1234);
}

static void test_cpuid(void)
{
    MK_INSN(cpuid, "cpuid");
    unsigned function = 0x1234;
    unsigned eax, ebx, ecx, edx;

    inregs.eax = eax = function;
    inregs.ecx = ecx = 0;
    asm("cpuid" : "+a"(eax), "=b"(ebx), "+c"(ecx), "=d"(edx));
    exec_in_big_real_mode(&insn_cpuid);
    report("cpuid", R_AX|R_BX|R_CX|R_DX,
	   outregs.eax == eax && outregs.ebx == ebx
	   && outregs.ecx == ecx && outregs.edx == edx);
}

static void test_ss_base_for_esp_ebp(void)
{
    MK_INSN(ssrel1, "mov %ss, %ax; mov %bx, %ss; movl (%ebp), %ebx; mov %ax, %ss");
    MK_INSN(ssrel2, "mov %ss, %ax; mov %bx, %ss; movl (%ebp,%edi,8), %ebx; mov %ax, %ss");
    static unsigned array[] = { 0x12345678, 0, 0, 0, 0x87654321 };

    inregs.ebx = 1;
    inregs.ebp = (unsigned)array;
    exec_in_big_real_mode(&insn_ssrel1);
    report("ss relative addressing (1)", R_AX | R_BX, outregs.ebx == 0x87654321);
    inregs.ebx = 1;
    inregs.ebp = (unsigned)array;
    inregs.edi = 0;
    exec_in_big_real_mode(&insn_ssrel2);
    report("ss relative addressing (2)", R_AX | R_BX, outregs.ebx == 0x87654321);
}

extern unsigned long long r_gdt[];

static void test_sgdt_sidt(void)
{
    MK_INSN(sgdt, "sgdtw (%eax)");
    MK_INSN(sidt, "sidtw (%eax)");
    struct table_descr x, y;

    inregs.eax = (unsigned)&y;
    asm volatile("sgdtw %0" : "=m"(x));
    exec_in_big_real_mode(&insn_sgdt);
    report("sgdt", 0, x.limit == y.limit && x.base == y.base);

    inregs.eax = (unsigned)&y;
    asm volatile("sidtw %0" : "=m"(x));
    exec_in_big_real_mode(&insn_sidt);
    report("sidt", 0, x.limit == y.limit && x.base == y.base);
}

static void test_sahf(void)
{
    MK_INSN(sahf, "sahf; pushfw; mov (%esp), %al; popfw");

    inregs.eax = 0xfd00;
    exec_in_big_real_mode(&insn_sahf);
    report("sahf", R_AX, outregs.eax == (inregs.eax | 0xd7));
}

static void test_lahf(void)
{
    MK_INSN(lahf, "pushfw; mov %al, (%esp); popfw; lahf");

    inregs.eax = 0xc7;
    exec_in_big_real_mode(&insn_lahf);
    report("lahf", R_AX, (outregs.eax >> 8) == inregs.eax);
}

static void test_movzx_movsx(void)
{
    MK_INSN(movsx, "movsx %al, %ebx");
    MK_INSN(movzx, "movzx %al, %ebx");
    MK_INSN(movzsah, "movsx %ah, %ebx");
    MK_INSN(movzxah, "movzx %ah, %ebx");

    inregs.eax = 0x1234569c;
    inregs.esp = 0xffff;
    exec_in_big_real_mode(&insn_movsx);
    report("movsx", R_BX, outregs.ebx == (signed char)inregs.eax);
    exec_in_big_real_mode(&insn_movzx);
    report("movzx", R_BX, outregs.ebx == (unsigned char)inregs.eax);
    exec_in_big_real_mode(&insn_movzsah);
    report("movsx ah", R_BX, outregs.ebx == (signed char)(inregs.eax>>8));
    exec_in_big_real_mode(&insn_movzxah);
    report("movzx ah", R_BX, outregs.ebx == (unsigned char)(inregs.eax >> 8));
}

static void test_bswap(void)
{
    MK_INSN(bswap, "bswap %ecx");

    inregs.ecx = 0x12345678;
    exec_in_big_real_mode(&insn_bswap);
    report("bswap", R_CX, outregs.ecx == 0x78563412);
}

static void test_aad(void)
{
    MK_INSN(aad, "aad");

    inregs.eax = 0x12345678;
    exec_in_big_real_mode(&insn_aad);
    report("aad", R_AX, outregs.eax == 0x123400d4);
}

static void test_aam(void)
{
    MK_INSN(aam, "aam");

    inregs.eax = 0x76543210;
    exec_in_big_real_mode(&insn_aam);
    report("aam", R_AX, outregs.eax == 0x76540106);
}

static void test_xlat(void)
{
    MK_INSN(xlat, "xlat");
    u8 table[256];
    int i;

    for (i = 0; i < 256; i++) {
        table[i] = i + 1;
    }

    inregs.eax = 0x89abcdef;
    inregs.ebx = (u32)table;
    exec_in_big_real_mode(&insn_xlat);
    report("xlat", R_AX, outregs.eax == 0x89abcdf0);
}

static void test_salc(void)
{
    MK_INSN(clc_salc, "clc; .byte 0xd6");
    MK_INSN(stc_salc, "stc; .byte 0xd6");

    inregs.eax = 0x12345678;
    exec_in_big_real_mode(&insn_clc_salc);
    report("salc (1)", R_AX, outregs.eax == 0x12345600);
    exec_in_big_real_mode(&insn_stc_salc);
    report("salc (2)", R_AX, outregs.eax == 0x123456ff);
}

static void test_fninit(void)
{
	u16 fcw = -1, fsw = -1;
	MK_INSN(fninit, "fninit ; fnstsw (%eax) ; fnstcw (%ebx)");

	inregs.eax = (u32)&fsw;
	inregs.ebx = (u32)&fcw;

	exec_in_big_real_mode(&insn_fninit);
	report("fninit", 0, fsw == 0 && (fcw & 0x103f) == 0x003f);
}

static void test_nopl(void)
{
	MK_INSN(nopl1, ".byte 0x90\n\r"); // 1 byte nop
	MK_INSN(nopl2, ".byte 0x66, 0x90\n\r"); // 2 bytes nop
	MK_INSN(nopl3, ".byte 0x0f, 0x1f, 0x00\n\r"); // 3 bytes nop
	MK_INSN(nopl4, ".byte 0x0f, 0x1f, 0x40, 0x00\n\r"); // 4 bytes nop
	exec_in_big_real_mode(&insn_nopl1);
	exec_in_big_real_mode(&insn_nopl2);
	exec_in_big_real_mode(&insn_nopl3);
	exec_in_big_real_mode(&insn_nopl4);
	report("nopl", 0, 1);
}

static u32 perf_baseline;

#define PERF_COUNT 1000000

#define MK_INSN_PERF(name, insn)                                \
	MK_INSN(name, "rdtsc; mov %eax, %ebx; mov %edx, %esi\n" \
		      "1:" insn "\n"                            \
		      ".byte 0x67; loop 1b\n"                   \
		      "rdtsc");

static u32 cycles_in_big_real_mode(struct insn_desc *insn)
{
	u64 start, end;

	inregs.ecx = PERF_COUNT;
	exec_in_big_real_mode(insn);
	start = ((u64)outregs.esi << 32) | outregs.ebx;
	end = ((u64)outregs.edx << 32) | outregs.eax;

	return end - start;
}

static void test_perf_loop(void)
{
	/*
	 * This test runs simple instructions that should roughly take the
	 * the same time to emulate: PERF_COUNT iterations of "loop" and 3
	 * setup instructions.  Other performance tests can run PERF_COUNT
	 * iterations of the same instruction and subtract the cycle count
	 * of this test.
	 */
	MK_INSN_PERF(perf_loop, "");
	perf_baseline = cycles_in_big_real_mode(&insn_perf_loop);
	print_serial_u32(perf_baseline / (PERF_COUNT + 3));
	print_serial(" cycles/emulated jump instruction\n");
}

static void test_perf_mov(void)
{
	u32 cyc;

	MK_INSN_PERF(perf_move, "mov %esi, %edi");
	cyc = cycles_in_big_real_mode(&insn_perf_move);
	print_serial_u32((cyc - perf_baseline) / PERF_COUNT);
	print_serial(" cycles/emulated move instruction\n");
}

static void test_perf_arith(void)
{
	u32 cyc;

	MK_INSN_PERF(perf_arith, "add $4, %edi");
	cyc = cycles_in_big_real_mode(&insn_perf_arith);
	print_serial_u32((cyc - perf_baseline) / PERF_COUNT);
	print_serial(" cycles/emulated arithmetic instruction\n");
}

static void test_perf_memory_load(void)
{
	u32 cyc, tmp;

	MK_INSN_PERF(perf_memory_load, "cmp $0, (%edi)");
	inregs.edi = (u32)&tmp;
	cyc = cycles_in_big_real_mode(&insn_perf_memory_load);
	print_serial_u32((cyc - perf_baseline) / PERF_COUNT);
	print_serial(" cycles/emulated memory load instruction\n");
}

static void test_perf_memory_store(void)
{
	u32 cyc, tmp;

	MK_INSN_PERF(perf_memory_store, "mov %ax, (%edi)");
	inregs.edi = (u32)&tmp;
	cyc = cycles_in_big_real_mode(&insn_perf_memory_store);
	print_serial_u32((cyc - perf_baseline) / PERF_COUNT);
	print_serial(" cycles/emulated memory store instruction\n");
}

static void test_perf_memory_rmw(void)
{
	u32 cyc, tmp;

	MK_INSN_PERF(perf_memory_rmw, "add $1, (%edi)");
	inregs.edi = (u32)&tmp;
	cyc = cycles_in_big_real_mode(&insn_perf_memory_rmw);
	print_serial_u32((cyc - perf_baseline) / PERF_COUNT);
	print_serial(" cycles/emulated memory RMW instruction\n");
}

void test_dr_mod(void)
{
	MK_INSN(drmod, "movl %ebx, %dr0\n\t"
		       ".byte 0x0f \n\t .byte 0x21 \n\t .byte 0x0\n\t");
	inregs.eax = 0xdead;
	inregs.ebx = 0xaced;
	exec_in_big_real_mode(&insn_drmod);
	report("mov dr with mod bits", R_AX | R_BX, outregs.eax == 0xaced);
}

void test_smsw(void)
{
	MK_INSN(smsw, "movl %cr0, %ebx\n\t"
		      "movl %ebx, %ecx\n\t"
		      "or $0x40000000, %ebx\n\t"
		      "movl %ebx, %cr0\n\t"
		      "smswl %eax\n\t"
		      "movl %ecx, %cr0\n\t");
	inregs.eax = 0x12345678;
	exec_in_big_real_mode(&insn_smsw);
	report("smsw", R_AX | R_BX | R_CX, outregs.eax == outregs.ebx);
}

void test_xadd(void)
{
	MK_INSN(xadd, "xaddl %eax, %eax\n\t");
	inregs.eax = 0x12345678;
	exec_in_big_real_mode(&insn_xadd);
	report("xadd", R_AX, outregs.eax == inregs.eax * 2);
}


void realmode_start(void)
{
	test_null();

	test_shld();
	test_push_pop();
	test_pusha_popa();
	test_mov_imm();
	test_cmp_imm();
	test_add_imm();
	test_sub_imm();
	test_xor_imm();
	test_io();
	test_eflags_insn();
	test_jcc_short();
	test_jcc_near();
	/* test_call() uses short jump so call it after testing jcc */
	test_call();
	/* long jmp test uses call near so test it after testing call */
	test_long_jmp();
	test_xchg();
	test_iret();
	test_int();
	test_imul();
	test_mul();
	test_div();
	test_idiv();
	test_loopcc();
	test_cbw();
	test_cwd_cdq();
	test_das();
	test_lds_lss();
	test_jcxz();
	test_cpuid();
	test_ss_base_for_esp_ebp();
	test_sgdt_sidt();
	test_lahf();
	test_sahf();
	test_movzx_movsx();
	test_bswap();
	test_aad();
	test_aam();
	test_xlat();
	test_salc();
	test_fninit();
	test_dr_mod();
	test_smsw();
	test_nopl();
	test_xadd();
	test_perf_loop();
	test_perf_mov();
	test_perf_arith();
	test_perf_memory_load();
	test_perf_memory_store();
	test_perf_memory_rmw();

	exit(failed);
}

unsigned long long r_gdt[] = { 0, 0x9b000000ffff, 0x93000000ffff };

struct table_descr r_gdt_descr = { sizeof(r_gdt) - 1, &r_gdt };

asm(
	".section .init \n\t"

	".code32 \n\t"

	"mb_magic = 0x1BADB002 \n\t"
	"mb_flags = 0x0 \n\t"

	"# multiboot header \n\t"
	".long mb_magic, mb_flags, 0 - (mb_magic + mb_flags) \n\t"

	".globl start \n\t"
	".data \n\t"
	". = . + 4096 \n\t"
	"stacktop: \n\t"

	".text \n\t"
	"start: \n\t"
	"lgdt r_gdt_descr \n\t"
	"ljmp $8, $1f; 1: \n\t"
	".code16gcc \n\t"
	"mov $16, %eax \n\t"
	"mov %ax, %ds \n\t"
	"mov %ax, %es \n\t"
	"mov %ax, %fs \n\t"
	"mov %ax, %gs \n\t"
	"mov %ax, %ss \n\t"
	"mov %cr0, %eax \n\t"
	"btc $0, %eax \n\t"
	"mov %eax, %cr0 \n\t"
	"ljmp $0, $realmode_entry \n\t"

	"realmode_entry: \n\t"

	"xor %ax, %ax \n\t"
	"mov %ax, %ds \n\t"
	"mov %ax, %es \n\t"
	"mov %ax, %ss \n\t"
	"mov %ax, %fs \n\t"
	"mov %ax, %gs \n\t"
	"mov $stacktop, %esp\n\t"
	"ljmp $0, $realmode_start \n\t"

	".code16gcc \n\t"
	);
