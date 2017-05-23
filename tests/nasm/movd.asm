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

	movd	mm0, [mydword]
	movd	[myaddress], mm0
	movd	mm1, [myaddress]
	movd	eax, mm0
	movd	mm4, eax
	mov     eax, 0x42
	movd    mm6, eax

loop:
	hlt
	jmp     loop

;;; mm0 = {-889275714, 0}
;;; mm1 = {-889275714, 0}
;;; mm4 = {-889275714, 0}
;;; mm6 = {66, 0}
;;; {"0":-889275714,"1":0,"2":-889275714,"3":0,"4":0,"5":0,"6":0,"7":0,"8":-889275714,"9":0,"10":0,"11":0,"12":66,"13":0,"14":0,"15":0}
