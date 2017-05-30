global _start

section .data
	align 16
quad1:
	dq	0x70ad80adad007fff
quad2:
	dq	0x7fff00428000ffff
quad3:
	dq	0x01008080f0f0ff42
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

	pcmpgtw	mm0, [quad2]
	pcmpgtw	mm0, [quad1]
	pcmpgtw	mm1, mm2
	pcmpgtw	mm2, [quad1]
	pcmpgtw	mm3, [quad1]


loop:
	hlt
	jmp     loop

;;; mm0 = {-65536, 65535}
;;; mm1 = {65535, -1}
;;; mm2 = {-65536, 0}
;;; mm3 = {0, -1}
;;; {"0":-65536,"1":65535,"2":65535,"3":-1,"4":-65536,"5":0,"6":0,"7":-1,"8":0,"9":0,"10":0,"11":0,"12":0,"13":0,"14":0,"15":0}
