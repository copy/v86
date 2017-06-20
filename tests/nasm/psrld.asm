global _start

section .data
	align 16
myquad:
	dq	0x8d0000ceffffadad
mydword:
	dd	0xcafebac0
shift1:
	dq	0x07
shift2:
	dq	-0x22

%include "header.inc"

	movq		mm0, [myquad]
	movq		mm1, [myquad]
	movq		mm2, [myquad]
	movq		mm6, [myquad]

	psrld		mm0, [shift1]
	psrld		mm1, 0xff
	psrld		mm2, [shift2]
	psrld		mm6, 0x5

%include "footer.inc"
