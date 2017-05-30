global _start

section .data
	align 16
myquad:
	dq	0xad0000ceffffadad
mydword:
	dd	0xcafebac0
shift1:
	dq	0x07
shift2:
	dq	-4

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
	movq		mm6, [myquad]

	psrlw		mm0, [shift1]
	psrlw		mm1, [mydword]
	psrlw		mm2, [shift2]
	psrlw		mm6, 0x5

loop:
	hlt
	jmp     loop

;;; mm0 = {33489243, 22675457}
;;; mm1 = {0, 0}
;;; mm2 = {0, 0}
;;; mm3 = {0, 0}
;;; mm4 = {0, 0}
;;; mm5 = {0, 0}
;;; mm6 = {134153581, 90701830}
;;; mm7 = {0, 0}
;;; {"0":33489243,"1":22675457,"2":0,"3":0,"4":0,"5":0,"6":0,"7":0,"8":0,"9":0,"10":0,"11":0,"12":134153581,"13":90701830,"14":0,"15":0}
