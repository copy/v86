/*
 * Copyright 2010 Siemens AG
 * Author: Jan Kiszka
 *
 * Released under GPLv2.
 */

#include "libcflat.h"
#include "x86/desc.h"

#define TSS_RETURN		(FIRST_SPARE_SEL)

void fault_entry(void);

static __attribute__((used, regparm(1))) void
fault_handler(unsigned long error_code)
{
	print_current_tss_info();
	printf("error code %lx\n", error_code);

	tss.eip += 2;

	gdt32[TSS_MAIN / 8].access &= ~2;

	set_gdt_task_gate(TSS_RETURN, tss_intr.prev);
}

asm (
	"fault_entry:\n"
	"	mov (%esp),%eax\n"
	"	call fault_handler\n"
	"	jmp $" xstr(TSS_RETURN) ", $0\n"
);

int main(int ac, char **av)
{
	const long invalid_segment = 0x1234;

	setup_tss32();
	set_intr_task_gate(13, fault_entry);

	asm (
		"mov %0,%%es\n"
		: : "r" (invalid_segment) : "edi"
	);

	printf("post fault\n");

	return 0;
}
