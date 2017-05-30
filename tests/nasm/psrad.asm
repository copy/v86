global _start

section .data
	align 16
myquad:
	dq	0xad0000ceadad00ff
mydword:
	dd	0xcafebac0
myaddress:
	dq	0x07

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
	movq		mm6, [myquad]

	psrad		mm0, [myaddress]
	psrad		mm1, 0x20
	psrad		mm6, 0x5

loop:
	hlt
	jmp     loop

;;; mm0 = {-10790399, -10878975}
;;; mm1 = {-1, -1}
;;; mm2 = {0, 0}
;;; mm3 = {0, 0}
;;; mm4 = {0, 0}
;;; mm5 = {0, 0}
;;; mm6 = {-43161593, -43515898}
;;; mm7 = {0, 0}
;;; {"0":-10790399,"1":-10878975,"2":-1,"3":-1,"4":0,"5":0,"6":0,"7":0,"8":0,"9":0,"10":0,"11":0,"12":-43161593,"13":-43515898,"14":0,"15":0}
