/*
 * Test for x86 cache and memory instructions
 *
 * Copyright (c) 2015 Red Hat Inc
 *
 * Authors:
 *  Eduardo Habkost <ehabkost@redhat.com>
 *
 * This work is licensed under the terms of the GNU GPL, version 2.
 */

#include "libcflat.h"
#include "desc.h"
#include "processor.h"

static long target;
static volatile int ud;
static volatile int isize;

static void handle_ud(struct ex_regs *regs)
{
	ud = 1;
	regs->rip += isize;
}

int main(int ac, char **av)
{
	struct cpuid cpuid7, cpuid1;
	int xfail;

	setup_idt();
	handle_exception(UD_VECTOR, handle_ud);

	cpuid1 = cpuid(1);
	cpuid7 = cpuid_indexed(7, 0);

	/* 3-byte instructions: */
	isize = 3;

	xfail = !(cpuid1.d & (1U << 19)); /* CLFLUSH */
	ud = 0;
	asm volatile("clflush (%0)" : : "b" (&target));
	report_xfail("clflush", xfail, ud == 0);

	xfail = !(cpuid1.d & (1U << 25)); /* SSE */
	ud = 0;
	asm volatile("sfence");
	report_xfail("sfence", xfail, ud == 0);

	xfail = !(cpuid1.d & (1U << 26)); /* SSE2 */
	ud = 0;
	asm volatile("lfence");
	report_xfail("lfence", xfail, ud == 0);

	ud = 0;
	asm volatile("mfence");
	report_xfail("mfence", xfail, ud == 0);

	/* 4-byte instructions: */
	isize = 4;

	xfail = !(cpuid7.b & (1U << 23)); /* CLFLUSHOPT */
	ud = 0;
	/* clflushopt (%rbx): */
	asm volatile(".byte 0x66, 0x0f, 0xae, 0x3b" : : "b" (&target));
	report_xfail("clflushopt", xfail, ud == 0);

	xfail = !(cpuid7.b & (1U << 24)); /* CLWB */
	ud = 0;
	/* clwb (%rbx): */
	asm volatile(".byte 0x66, 0x0f, 0xae, 0x33" : : "b" (&target));
	report_xfail("clwb", xfail, ud == 0);

	ud = 0;
	/* clwb requires a memory operand, the following is NOT a valid
	 * CLWB instruction (modrm == 0xF0).
	 */
	asm volatile(".byte 0x66, 0x0f, 0xae, 0xf0");
	report("fake clwb", ud);

	xfail = !(cpuid7.b & (1U << 22)); /* PCOMMIT */
	ud = 0;
	/* pcommit: */
	asm volatile(".byte 0x66, 0x0f, 0xae, 0xf8");
	report_xfail("pcommit", xfail, ud == 0);

	return report_summary();
}
