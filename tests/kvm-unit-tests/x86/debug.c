/*
 * Test for x86 debugging facilities
 *
 * Copyright (c) Siemens AG, 2014
 *
 * Authors:
 *  Jan Kiszka <jan.kiszka@siemens.com>
 *
 * This work is licensed under the terms of the GNU GPL, version 2.
 */

#include "libcflat.h"
#include "desc.h"

static volatile unsigned long bp_addr[10], dr6[10];
static volatile unsigned int n;
static volatile unsigned long value;

static unsigned long get_dr6(void)
{
	unsigned long value;

	asm volatile("mov %%dr6,%0" : "=r" (value));
	return value;
}

static void set_dr0(void *value)
{
	asm volatile("mov %0,%%dr0" : : "r" (value));
}

static void set_dr1(void *value)
{
	asm volatile("mov %0,%%dr1" : : "r" (value));
}

static void set_dr6(unsigned long value)
{
	asm volatile("mov %0,%%dr6" : : "r" (value));
}

static void set_dr7(unsigned long value)
{
	asm volatile("mov %0,%%dr7" : : "r" (value));
}

static void handle_db(struct ex_regs *regs)
{
	bp_addr[n] = regs->rip;
	dr6[n] = get_dr6();

	if (dr6[n] & 0x1)
		regs->rflags |= (1 << 16);

	if (++n >= 10) {
		regs->rflags &= ~(1 << 8);
		set_dr7(0x00000400);
	}
}

static void handle_bp(struct ex_regs *regs)
{
	bp_addr[0] = regs->rip;
}

int main(int ac, char **av)
{
	unsigned long start;

	setup_idt();
	handle_exception(DB_VECTOR, handle_db);
	handle_exception(BP_VECTOR, handle_bp);

sw_bp:
	asm volatile("int3");
	report("#BP", bp_addr[0] == (unsigned long)&&sw_bp + 1);

	n = 0;
	set_dr0(&&hw_bp1);
	set_dr7(0x00000402);
hw_bp1:
	asm volatile("nop");
	report("hw breakpoint (test that dr6.BS is not set)",
	       n == 1 &&
	       bp_addr[0] == ((unsigned long)&&hw_bp1) && dr6[0] == 0xffff0ff1);

	n = 0;
	set_dr0(&&hw_bp2);
	set_dr6(0x00004002);
hw_bp2:
	asm volatile("nop");
	report("hw breakpoint (test that dr6.BS is not cleared)",
	       n == 1 &&
	       bp_addr[0] == ((unsigned long)&&hw_bp2) && dr6[0] == 0xffff4ff1);

	n = 0;
	set_dr6(0);
	asm volatile(
		"pushf\n\t"
		"pop %%rax\n\t"
		"or $(1<<8),%%rax\n\t"
		"push %%rax\n\t"
		"lea (%%rip),%0\n\t"
		"popf\n\t"
		"and $~(1<<8),%%rax\n\t"
		"push %%rax\n\t"
		"popf\n\t"
		: "=g" (start) : : "rax");
	report("single step",
	       n == 3 &&
	       bp_addr[0] == start+1+6 && dr6[0] == 0xffff4ff0 &&
	       bp_addr[1] == start+1+6+1 && dr6[1] == 0xffff4ff0 &&
	       bp_addr[2] == start+1+6+1+1 && dr6[2] == 0xffff4ff0);

	/*
	 * cpuid and rdmsr (among others) trigger VM exits and are then
	 * emulated. Test that single stepping works on emulated instructions.
	 */
	n = 0;
	set_dr6(0);
	asm volatile(
		"pushf\n\t"
		"pop %%rax\n\t"
		"or $(1<<8),%%rax\n\t"
		"push %%rax\n\t"
		"lea (%%rip),%0\n\t"
		"popf\n\t"
		"and $~(1<<8),%%rax\n\t"
		"push %%rax\n\t"
		"xor %%rax,%%rax\n\t"
		"cpuid\n\t"
		"movl $0x1a0,%%ecx\n\t"
		"rdmsr\n\t"
		"popf\n\t"
		: "=g" (start) : : "rax", "ebx", "ecx", "edx");
	report("single step emulated instructions",
	       n == 7 &&
	       bp_addr[0] == start+1+6 && dr6[0] == 0xffff4ff0 &&
	       bp_addr[1] == start+1+6+1 && dr6[1] == 0xffff4ff0 &&
	       bp_addr[2] == start+1+6+1+3 && dr6[2] == 0xffff4ff0 &&
	       bp_addr[3] == start+1+6+1+3+2 && dr6[3] == 0xffff4ff0 &&
	       bp_addr[4] == start+1+6+1+3+2+5 && dr6[4] == 0xffff4ff0 &&
	       bp_addr[5] == start+1+6+1+3+2+5+2 && dr6[5] == 0xffff4ff0 &&
	       bp_addr[6] == start+1+6+1+3+2+5+2+1 && dr6[6] == 0xffff4ff0);

	n = 0;
	set_dr1((void *)&value);
	set_dr7(0x00d0040a);

	asm volatile(
		"mov $42,%%rax\n\t"
		"mov %%rax,%0\n\t"
		: "=m" (value) : : "rax");
hw_wp1:
	report("hw watchpoint (test that dr6.BS is not cleared)",
	       n == 1 &&
	       bp_addr[0] == ((unsigned long)&&hw_wp1) && dr6[0] == 0xffff4ff2);

	n = 0;
	set_dr6(0);

	asm volatile(
		"mov $42,%%rax\n\t"
		"mov %%rax,%0\n\t"
		: "=m" (value) : : "rax");
hw_wp2:
	report("hw watchpoint (test that dr6.BS is not set)",
	       n == 1 &&
	       bp_addr[0] == ((unsigned long)&&hw_wp2) && dr6[0] == 0xffff0ff2);

	n = 0;
	set_dr6(0);
sw_icebp:
	asm volatile(".byte 0xf1");
	report("icebp",
	       n == 1 &&
	       bp_addr[0] == (unsigned long)&&sw_icebp + 1 &&
	       dr6[0] == 0xffff0ff0);

	return report_summary();
}
