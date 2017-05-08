global _start

section .data
	align 16
myquad:
	dq	0x1234567890abcdef
mydword:
	dd	0xcafebabe
myaddress:
	dd	0xdeadbeef

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

	movq	mm0, [myquad]
	movq	[myaddress], mm0
	movq	mm1, [myaddress]
	movq	mm4, mm0

loop:
	hlt
	jmp     loop

;;; reg_mmxs should be:
;;; "{"0":-1867788817,"1":305419896,"2":-1867788817,"3":305419896,"4":0,"5":0,"6":0,"7":0,"8":-1867788817,"9":305419896,"10":0,"11":0,"12":0,"13":0,"14":0,"15":0}"
