global _start

section .data
	align 16
myquad:
	dq	0x1234567890abcdef
mydword:
	dd	0xcafebabe
myaddress:
	dd	0xdeadbeef

%include "header.inc"

	movq	mm0, [myquad]
	movq	[myaddress], mm0
	movq	mm1, [myaddress]
	movq	mm4, mm0

%include "footer.inc"
