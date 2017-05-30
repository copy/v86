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
	movq		mm6, [myquad]

	psrlq		mm0, [shift1]
	psrlq		mm1, [shift2]
	psrlq		mm2, 0x65
	psrlq		mm3, 0x25
	psrlq		mm6, 0x5

loop:
	hlt
	jmp     loop

;;; mm0 = {-1654957567, 18481153}
;;; mm1 = {0, 0}
;;; mm2 = {0, 0}
;;; mm3 = {73924614, 0}
;;; mm4 = {0, 0}
;;; mm5 = {0, 0}
;;; mm6 = {1970104327, 73924614}
;;; mm7 = {0, 0}
;;; {"0":-1654957567,"1":18481153,"2":0,"3":0,"4":0,"5":0,"6":73924614,"7":0,"8":0,"9":0,"10":0,"11":0,"12":1970104327,"13":73924614,"14":0,"15":0}
