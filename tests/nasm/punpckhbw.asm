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

	punpckhbw	mm0, [myaddress]
	punpckhbw	mm0, mm1
	punpckhbw	mm1, [quad2]
	punpckhbw	mm2, [quad1]
	punpckhbw	mm3, [quad1]

loop:
	hlt
	jmp     loop

;;; mm0 = {11403229, 65484}
;;; mm1 = {-1442792449, -1442792449}
;;; mm2 = {-861217349, -861217349}
;;; mm3 = {-872358401, -872358401}
;;; mm4 = {0, 0}
;;; mm5 = {0, 0}
;;; mm6 = {0, 0}
;;; mm7 = {0, 0}
;;; {"0":11403229,"1":65484,"2":-1442792449,"3":-1442792449,"4":-861217349,"5":-861217349,"6":-872358401,"7":-872358401,"8":0,"9":0,"10":0,"11":0,"12":0,"13":0,"14":0,"15":0}
