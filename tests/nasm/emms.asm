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
	fld	dword [mydword]
	fld	dword [myquad]
	emms

loop:
	hlt
	jmp     loop

;;; fptag = 0xFFFF
;;; cpu.fpu.load_tag_word() = 0xFFFF

;;; The automated nasm test fails because MMX registers are meant to
;;; alias the mantissa part of the 80-bit x87 registers, which we're
;;; ignoring at the moment.
