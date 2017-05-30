global _start

section .data
	align 16
quad1:
	dq	0x00ad00adad007fff
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

	pcmpgtb	mm0, [quad2]
	pcmpgtb	mm0, [quad1]
	pcmpgtb	mm1, [quad3]
	pcmpgtb	mm2, [quad1]
	pcmpgtb	mm3, [quad1]


loop:
	hlt
	jmp     loop

;;; mm0 = {-16776961, 16711935}
;;; mm1 = {16711680, -16711681}
;;; mm2 = {-16776961, -65536}
;;; mm3 = {0, -65281}
;;; {"0":-16776961,"1":16711935,"2":16711680,"3":-16711681,"4":-16776961,"5":-65536,"6":0,"7":-65281,"8":0,"9":0,"10":0,"11":0,"12":0,"13":0,"14":0,"15":0}
