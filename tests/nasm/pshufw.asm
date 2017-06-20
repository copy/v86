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

	movq		mm0, [myquad]
	pshufw		mm0, [myaddress], 0xAB
	pshufw		mm1, [myaddress], 0xFE
	pshufw		mm2, [myquad], 0xFF
	pshufw		mm6, [myaddress], 0x19
	pshufw		mm7, [myaddress], 0xB5
%include "footer.inc"
