global _start

section .data
	align 16

quad1:
	dq	0xccddccddad007fff
quad2:
	dq	0xaabbaabbad007fff
quad3:
	dq	0x00ff00ffad007fff

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
	movq		mm1, [quad3]
	movq		mm2, [quad2]
	movq		mm3, [quad3]

	punpckhdq	mm0, [myaddress]
	punpckhdq	mm0, mm1
	punpckhdq	mm1, [quad2]
	punpckhdq	mm2, [quad1]
	punpckhdq	mm3, [quad1]

loop:
	hlt
	jmp     loop

;;; mm0 = {11386607, 16711935}
;;; mm1 = {16711935, -1430541637}
;;; mm2 = {-1430541637, -857879331}
;;; mm3 = {16711935, -857879331}
;;; mm4 = {0, 0}
;;; mm5 = {0, 0}
;;; mm6 = {0, 0}
;;; mm7 = {0, 0}
;;; {"0":11386607,"1":16711935,"2":16711935,"3":-1430541637,"4":-1430541637,"5":-857879331,"6":16711935,"7":-857879331,"8":0,"9":0,"10":0,"11":0,"12":0,"13":0,"14":0,"15":0}
