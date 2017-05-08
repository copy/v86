global _start

section .data
	align 16
myquad:
	dq	0xad0000ceadad00ff
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
	movq		mm0, [myquad]
	pshufw		mm0, [myaddress], 0xAB
	pshufw		mm1, [myaddress], 0xFE
	pshufw		mm2, [myquad], 0xFF
	pshufw		mm6, [myaddress], 0x19
	pshufw		mm7, [myaddress], 0xB5
loop:
	hlt
	jmp     loop

;;; mm0 = 0xBEEFBEEFBEEF00AD
;;; mm1 = 0x00AD00AD00ADBEEF
;;; mm2 = 0xAD00AD00AD00AD00
;;; mm6 = 0x00CEC0DEBEEFC0DE
;;; mm7 = 0xBEEF00ADC0DEC0DE
;;; reg_mmxs:
;;; {"0":-1091632979,"1":-1091584273,"2":11386607,"3":11337901,"4":-1392464640,"5":-1392464640,"6":0,"7":0,"8":0,"9":0,"10":0,"11":0,"12":-1091583778,"13":13549790,"14":-1059143458,"15":-1091632979}
