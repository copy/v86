global _start

section .data
	align 16
quad1:
	dq	0x70ad80ad7fffffff
quad2:
	dq	0x7fff00428000ffff
quad3:
	dq	0xf100808080f0ff42
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
	movq		mm2, [quad3]
	movq		mm3, [quad2]

	pcmpgtd	mm0, [quad2]
	pcmpgtd	mm0, [quad1]
	pcmpgtd	mm1, mm2
	pcmpgtd	mm2, [quad1]
	pcmpgtd	mm3, [quad1]


loop:
	hlt
	jmp     loop

;;; mm0 = {0, 0}
;;; mm1 = {0, -1}
;;; mm2 = {0, 0}
;;; mm3 = {0, -1}
;;; mm4 = {0, 0}
;;; mm5 = {0, 0}
;;; mm6 = {0, 0}
;;; mm7 = {0, 0}
;;; {"0":0,"1":0,"2":0,"3":-1,"4":0,"5":0,"6":0,"7":-1,"8":0,"9":0,"10":0,"11":0,"12":0,"13":0,"14":0,"15":0}
