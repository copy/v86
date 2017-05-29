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

	punpcklwd	mm0, [myaddress]
	punpcklwd	mm0, [quad1]
	punpcklwd	mm1, [quad2]
	punpcklwd	mm2, [myaddress]
	punpcklwd	mm3, [quad1]

loop:
	hlt
	jmp     loop

;;; mm0 = {2147450879, -1392508722}
;;; mm1 = {-251662081, -492969315}
;;; mm2 = {13533183, -1059148544}
;;; mm3 = {2147479807, -1392450915}
;;; {"0":2147450879,"1":-1392508722,"2":-251662081,"3":-492969315,"4":13533183,"5":-1059148544,"6":2147479807,"7":-1392450915,"8":0,"9":0,"10":0,"11":0,"12":0,"13":0,"14":0,"15":0}
