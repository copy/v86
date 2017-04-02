
#include "apic-defs.h"

.globl boot_idt
boot_idt = 0

.globl idt_descr
.globl tss_descr
.globl gdt64_desc

ipi_vector = 0x20

max_cpus = 64

.bss

	. = . + 4096 * max_cpus
	.align 16
stacktop:

	. = . + 4096
	.align 16
ring0stacktop:

.data

.align 4096
.globl ptl2
ptl2:
i = 0
	.rept 512 * 4
	.quad 0x1e7 | (i << 21)
	i = i + 1
	.endr

.align 4096
ptl3:
	.quad ptl2 + 7 + 0 * 4096
	.quad ptl2 + 7 + 1 * 4096
	.quad ptl2 + 7 + 2 * 4096
	.quad ptl2 + 7 + 3 * 4096

.align 4096
ptl4:
	.quad ptl3 + 7

.align 4096

gdt64_desc:
	.word gdt64_end - gdt64 - 1
	.quad gdt64

gdt64:
	.quad 0
	.quad 0x00af9b000000ffff // 64-bit code segment
	.quad 0x00cf93000000ffff // 64-bit data segment
	.quad 0x00af1b000000ffff // 64-bit code segment, not present
	.quad 0x00affb000000ffff // 64-bit code segment (user)
	.quad 0x00cff3000000ffff // 64-bit data segment (user)
	.quad 0x00cf9b000000ffff // 32-bit code segment
	.quad 0x00cf92000000ffff // 32-bit data segment
	.quad 0x008F9A000000FFFF // 16-bit code segment
	.quad 0x008F92000000FFFF // 16-bit data segment

	.quad 0			 // 6 spare selectors
	.quad 0
	.quad 0
	.quad 0
	.quad 0
	.quad 0

tss_descr:
	.rept max_cpus
	.quad 0x000089000000ffff // 64-bit avail tss
	.quad 0                  // tss high addr
	.endr
gdt64_end:

i = 0
.globl tss
tss:
	.rept max_cpus
	.long 0
	.quad ring0stacktop - i * 4096
	.quad 0, 0
	.quad 0, 0, 0, 0, 0, 0, 0, 0
	.long 0, 0, 0
i = i + 1
	.endr
tss_end:

mb_boot_info:	.quad 0

.section .init

.code32

mb_magic = 0x1BADB002
mb_flags = 0x0

	# multiboot header
	.long mb_magic, mb_flags, 0 - (mb_magic + mb_flags)
mb_cmdline = 16

MSR_GS_BASE = 0xc0000101

.macro setup_percpu_area
	lea -4096(%esp), %eax
	mov $0, %edx
	mov $MSR_GS_BASE, %ecx
	wrmsr
.endm

.globl start
start:
	mov %ebx, mb_boot_info
	mov $stacktop, %esp
	setup_percpu_area
	call prepare_64
	jmpl $8, $start64

prepare_64:
	lgdt gdt64_desc

	mov %cr4, %eax
	bts $5, %eax  // pae
	mov %eax, %cr4

	mov $ptl4, %eax
	mov %eax, %cr3

efer = 0xc0000080
	mov $efer, %ecx
	rdmsr
	bts $8, %eax
	wrmsr

	mov %cr0, %eax
	bts $0, %eax
	bts $31, %eax
	mov %eax, %cr0
	ret

smp_stacktop:	.long 0xa0000

.align 16

gdt32:
	.quad 0
	.quad 0x00cf9b000000ffff // flat 32-bit code segment
	.quad 0x00cf93000000ffff // flat 32-bit data segment
gdt32_end:

.code16
sipi_entry:
	mov %cr0, %eax
	or $1, %eax
	mov %eax, %cr0
	lgdtl gdt32_descr - sipi_entry
	ljmpl $8, $ap_start32

gdt32_descr:
	.word gdt32_end - gdt32 - 1
	.long gdt32

sipi_end:

.code32
ap_start32:
	mov $0x10, %ax
	mov %ax, %ds
	mov %ax, %es
	mov %ax, %fs
	mov %ax, %gs
	mov %ax, %ss
	mov $-4096, %esp
	lock/xaddl %esp, smp_stacktop
	setup_percpu_area
	call prepare_64
	ljmpl $8, $ap_start64

.code64
ap_start64:
	call load_tss
	call enable_apic
	call enable_x2apic
	sti
	nop
	lock incw cpu_online_count

1:	hlt
	jmp 1b

start64:
	call load_tss
	call mask_pic_interrupts
	call enable_apic
	call smp_init
	call enable_x2apic
	mov mb_boot_info(%rip), %rbx
	mov %rbx, %rdi
	call setup_get_initrd
	call setup_environ
	mov mb_cmdline(%rbx), %eax
	mov %rax, __args(%rip)
	call __setup_args
	mov __argc(%rip), %edi
	lea __argv(%rip), %rsi
	lea __environ(%rip), %rdx
	call main
	mov %eax, %edi
	call exit

idt_descr:
	.word 16 * 256 - 1
	.quad boot_idt

load_tss:
	lidtq idt_descr
	mov $(APIC_DEFAULT_PHYS_BASE + APIC_ID), %eax
	mov (%rax), %eax
	shr $24, %eax
	mov %eax, %ebx
	shl $4, %ebx
	mov $((tss_end - tss) / max_cpus), %edx
	imul %edx
	add $tss, %rax
	mov %ax, tss_descr+2(%rbx)
	shr $16, %rax
	mov %al, tss_descr+4(%rbx)
	shr $8, %rax
	mov %al, tss_descr+7(%rbx)
	shr $8, %rax
	mov %eax, tss_descr+8(%rbx)
	lea tss_descr-gdt64(%rbx), %rax
	ltr %ax
	ret

smp_init:
	cld
	lea sipi_entry, %rsi
	xor %rdi, %rdi
	mov $(sipi_end - sipi_entry), %rcx
	rep/movsb
	mov $APIC_DEFAULT_PHYS_BASE, %eax
	movl $(APIC_DEST_ALLBUT | APIC_DEST_PHYSICAL | APIC_DM_INIT | APIC_INT_ASSERT), APIC_ICR(%rax)
	movl $(APIC_DEST_ALLBUT | APIC_DEST_PHYSICAL | APIC_DM_INIT), APIC_ICR(%rax)
	movl $(APIC_DEST_ALLBUT | APIC_DEST_PHYSICAL | APIC_DM_STARTUP), APIC_ICR(%rax)
	call fwcfg_get_nb_cpus
1:	pause
	cmpw %ax, cpu_online_count
	jne 1b
smp_init_done:
	ret

cpu_online_count:	.word 1
