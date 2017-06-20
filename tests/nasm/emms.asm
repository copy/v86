global _start

section .data
	align 16
myquad:
	dq	0xad0000ceadad00ff
mydword:
	dd	0xcafebabe
myaddress:
	dq	0x00adbeefc0de00ce

%include "header.inc"

	fld	dword [mydword]
	fld	dword [myquad]
	emms

%include "footer.inc"

;;; fptag = 0xFFFF
;;; cpu.fpu.load_tag_word() = 0xFFFF

;;; The automated nasm test fails because MMX registers are meant to
;;; alias the mantissa part of the 80-bit x87 registers, which we're
;;; ignoring at the moment.
