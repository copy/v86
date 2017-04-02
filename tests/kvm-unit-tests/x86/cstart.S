
#include "apic-defs.h"

.globl boot_idt
boot_idt = 0

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
pt:
i = 0
        .rept 1024
        .long 0x1e7 | (i << 22)
        i = i + 1
        .endr

.globl gdt32
gdt32:
	.quad 0
	.quad 0x00cf9b000000ffff // flat 32-bit code segment
	.quad 0x00cf93000000ffff // flat 32-bit data segment
	.quad 0x00cf1b000000ffff // flat 32-bit code segment, not present
	.quad 0x00cffb000000ffff // 64-bit code segment (user)
	.quad 0x00cff3000000ffff // 64-bit data segment (user)

	.quad 0			 // 10 spare selectors
	.quad 0
	.quad 0
	.quad 0
	.quad 0
	.quad 0
	.quad 0
	.quad 0
	.quad 0
	.quad 0

tss_descr:
        .rept max_cpus
        .quad 0x000089000000ffff // 32-bit avail tss
        .endr
gdt32_end:

i = 0
.globl tss
tss:
        .rept max_cpus
        .long 0
        .long ring0stacktop - i * 4096
        .long 16
        .quad 0, 0
        .quad 0, 0, 0, 0, 0, 0, 0, 0
        .long 0, 0, 0
        i = i + 1
        .endr
tss_end:

idt_descr:
	.word 16 * 256 - 1
	.long boot_idt

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
        push %ebx
        call setup_get_initrd
        call setup_environ
        mov mb_cmdline(%ebx), %eax
        mov %eax, __args
        call __setup_args
        mov $stacktop, %esp
        setup_percpu_area
        call prepare_32
        jmpl $8, $start32

prepare_32:
        lgdtl gdt32_descr

	mov %cr4, %eax
	bts $4, %eax  // pse
	mov %eax, %cr4

	mov $pt, %eax
	mov %eax, %cr3

	mov %cr0, %eax
	bts $0, %eax
	bts $31, %eax
	mov %eax, %cr0
	ret

smp_stacktop:	.long 0xa0000

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
	call prepare_32
	call load_tss
	call enable_apic
	call enable_x2apic
	sti
	nop
	lock incw cpu_online_count

1:	hlt
	jmp 1b

start32:
	call load_tss
	call mask_pic_interrupts
	call enable_apic
	call smp_init
	call enable_x2apic
        push $__environ
        push $__argv
        push __argc
        call main
	push %eax
	call exit

load_tss:
	lidt idt_descr
	mov $16, %eax
	mov %ax, %ss
	mov $(APIC_DEFAULT_PHYS_BASE + APIC_ID), %eax
	mov (%eax), %eax
	shr $24, %eax
	mov %eax, %ebx
	shl $3, %ebx
	mov $((tss_end - tss) / max_cpus), %edx
	imul %edx
	add $tss, %eax
	mov %ax, tss_descr+2(%ebx)
	shr $16, %eax
	mov %al, tss_descr+4(%ebx)
	shr $8, %eax
	mov %al, tss_descr+7(%ebx)
	lea tss_descr-gdt32(%ebx), %eax
	ltr %ax
	ret

smp_init:
	cld
	lea sipi_entry, %esi
	xor %edi, %edi
	mov $(sipi_end - sipi_entry), %ecx
	rep/movsb
	mov $APIC_DEFAULT_PHYS_BASE, %eax
	movl $(APIC_DEST_ALLBUT | APIC_DEST_PHYSICAL | APIC_DM_INIT | APIC_INT_ASSERT), APIC_ICR(%eax)
	movl $(APIC_DEST_ALLBUT | APIC_DEST_PHYSICAL | APIC_DM_INIT), APIC_ICR(%eax)
	movl $(APIC_DEST_ALLBUT | APIC_DEST_PHYSICAL | APIC_DM_STARTUP), APIC_ICR(%eax)
	call fwcfg_get_nb_cpus
1:	pause
	cmpw %ax, cpu_online_count
	jne 1b
smp_init_done:
	ret

cpu_online_count:	.word 1

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
