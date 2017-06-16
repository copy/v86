global _start

section .data
	align 16
myquad:
	dq	0x8d0000ceadad00ff
mydword:
	dd	0xcafebac0
shift1:
	dq	0x07
shift2:
	dq	-0x22

MBALIGN     equ  1<<0                   ; align loaded modules on page boundaries
MEMINFO     equ  1<<1                   ; provide memory map
FLAGS       equ  0                      ; this is the Multiboot 'flag' field
MAGIC       equ  0x1BADB002             ; 'magic number' lets bootloader find the header
CHECKSUM    equ -(MAGIC + FLAGS)        ; checksum of above, to prove we are multiboot
section .multiboot
align 4
    dd MAGIC
    dd FLAGS
    dd CHECKSUM

section .text

_start:
main:
	movq		mm0, [myquad]
	movq		mm1, [myquad]
	movq		mm2, [myquad]
	movq		mm3, [myquad]
	movq		mm4, [myquad]
	movq		mm6, [myquad]

	psllq		mm0, [shift1]
	psllq		mm1, [shift2]
	psllq		mm2, 0x65
	psllq		mm3, 0x25
	psllq		mm4, 0x1F
	psllq		mm6, 0x5

loop:
	hlt
	jmp     loop

