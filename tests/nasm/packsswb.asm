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

	packsswb	mm0, [quad3]
	packsswb	mm0, [quad1]
	packsswb	mm1, [quad3]
	packsswb	mm2, [quad1]
	packsswb	mm3, [quad1]


loop:
	hlt
	jmp     loop

;;; mm0 = {2139127680, 2139062399}
;;; mm1 = {2135064831, 2139127936}
;;; mm2 = {2139127936, 2139062399}
;;; mm3 = {2135064831, 2139062399}
;;; {"0":2139127680,"1":2139062399,"2":2135064831,"3":2139127936,"4":2139127936,"5":2139062399,"6":2135064831,"7":2139062399,"8":0,"9":0,"10":0,"11":0,"12":0,"13":0,"14":0,"15":0}
