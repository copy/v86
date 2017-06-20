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


	movd	mm0, [mydword]
	movd	[myaddress], mm0
	movd	mm1, [myaddress]
	movd	eax, mm0
	movd	mm4, eax
	mov     eax, 0x42
	movd    mm6, eax

%include "footer.inc"
