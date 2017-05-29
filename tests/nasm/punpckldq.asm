global _start

section .data
	align 16
quad1:
	dq	0x00ad00adad007fff
quad2:
	dq	0xac4b1b9de29df0ff
mydword:
	dd	0xcafebabe
myaddress:
	dq	0x00adbeefc0de00ce

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
	movq		mm0, [quad1]
	movq		mm1, [quad2]
	movq		mm2, [quad1]
	movq		mm3, [quad2]

	punpckldq	mm0, [myaddress]
	punpckldq	mm0, [quad1]
	punpckldq	mm1, [quad2]
	punpckldq	mm2, [myaddress]
	punpckldq	mm3, [quad1]

loop:
	hlt
	jmp     loop

;;; mm0 = {-1392476161, -1392476161}
;;; mm1 = {-492965633, -492965633}
;;; mm2 = {-1392476161, -1059192626}
;;; mm3 = {-492965633, -1392476161}
;;; {"0":-1392476161,"1":-1392476161,"2":-492965633,"3":-492965633,"4":-1392476161,"5":-1059192626,"6":-492965633,"7":-1392476161,"8":0,"9":0,"10":0,"11":0,"12":0,"13":0,"14":0,"15":0}
