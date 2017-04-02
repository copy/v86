#include "libcflat.h"
#include "isr.h"
#include "vm.h"
#include "desc.h"

extern char isr_entry_point[];

asm (
    "isr_entry_point: \n"
#ifdef __x86_64__
    "push %r15 \n\t"
    "push %r14 \n\t"
    "push %r13 \n\t"
    "push %r12 \n\t"
    "push %r11 \n\t"
    "push %r10 \n\t"
    "push %r9  \n\t"
    "push %r8  \n\t"
#endif
    "push %"R "di \n\t"
    "push %"R "si \n\t"
    "push %"R "bp \n\t"
    "push %"R "sp \n\t"
    "push %"R "bx \n\t"
    "push %"R "dx \n\t"
    "push %"R "cx \n\t"
    "push %"R "ax \n\t"
#ifdef __x86_64__
    "mov %rsp, %rdi \n\t"
    "callq *8*16(%rsp) \n\t"
#else
    "push %esp \n\t"
    "calll *4+4*8(%esp) \n\t"
    "add $4, %esp \n\t"
#endif
    "pop %"R "ax \n\t"
    "pop %"R "cx \n\t"
    "pop %"R "dx \n\t"
    "pop %"R "bx \n\t"
    "pop %"R "bp \n\t"
    "pop %"R "bp \n\t"
    "pop %"R "si \n\t"
    "pop %"R "di \n\t"
#ifdef __x86_64__
    "pop %r8  \n\t"
    "pop %r9  \n\t"
    "pop %r10 \n\t"
    "pop %r11 \n\t"
    "pop %r12 \n\t"
    "pop %r13 \n\t"
    "pop %r14 \n\t"
    "pop %r15 \n\t"
#endif
    ".globl isr_iret_ip\n\t"
#ifdef __x86_64__
    "add $8, %rsp \n\t"
    "isr_iret_ip: \n\t"
    "iretq \n\t"
#else
    "add $4, %esp \n\t"
    "isr_iret_ip: \n\t"
    "iretl \n\t"
#endif
    );

void handle_irq(unsigned vec, void (*func)(isr_regs_t *regs))
{
    u8 *thunk = vmalloc(50);

    set_idt_entry(vec, thunk, 0);

#ifdef __x86_64__
    /* sub $8, %rsp */
    *thunk++ = 0x48; *thunk++ = 0x83; *thunk++ = 0xec; *thunk++ = 0x08;
    /* mov $func_low, %(rsp) */
    *thunk++ = 0xc7; *thunk++ = 0x04; *thunk++ = 0x24;
    *(u32 *)thunk = (ulong)func; thunk += 4;
    /* mov $func_high, %(rsp+4) */
    *thunk++ = 0xc7; *thunk++ = 0x44; *thunk++ = 0x24; *thunk++ = 0x04;
    *(u32 *)thunk = (ulong)func >> 32; thunk += 4;
    /* jmp isr_entry_point */
    *thunk ++ = 0xe9;
    *(u32 *)thunk = (ulong)isr_entry_point - (ulong)(thunk + 4);
#else
    /* push $func */
    *thunk++ = 0x68;
    *(u32 *)thunk = (ulong)func; thunk += 4;
    /* jmp isr_entry_point */
    *thunk++ = 0xe9;
    *(u32 *)thunk = (ulong)isr_entry_point - (ulong)(thunk + 4);
#endif
}

void handle_external_interrupt(int vector)
{
	idt_entry_t *idt = &boot_idt[vector];
	unsigned long entry =
		idt->offset0 | ((unsigned long)idt->offset1 << 16);
#ifdef __x86_64__
	unsigned long tmp;
	entry |= ((unsigned long)idt->offset2 << 32);
#endif

	asm volatile(
#ifdef __x86_64__
		     "mov %%rsp, %[sp]\n\t"
		     "and $0xfffffffffffffff0, %%rsp\n\t"
		     "push $%c[ss]\n\t"
		     "push %[sp]\n\t"
#endif
		     "pushf\n\t"
		     "orl $0x200, (%%"R "sp)\n\t"
		     "push $%c[cs]\n\t"
		     "call *%[entry]\n\t"
		     :
#ifdef __x86_64__
		     [sp]"=&r"(tmp)
#endif
		     :
		     [entry]"r"(entry),
		     [ss]"i"(KERNEL_DS),
		     [cs]"i"(KERNEL_CS)
		     );
}
