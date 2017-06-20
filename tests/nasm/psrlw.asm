global _start

section .data
	align 16
myquad:
	dq	0xad0000ceffffadad
mydword:
	dd	0xcafebac0
shift1:
	dq	0x07
shift2:
	dq	-4

%include "header.inc"

	movq		mm0, [myquad]
	movq		mm1, [myquad]
	movq		mm2, [myquad]
	movq		mm6, [myquad]

	psrlw		mm0, [shift1]
	psrlw		mm1, [mydword]
	psrlw		mm2, [shift2]
	psrlw		mm6, 0x5

%include "footer.inc"
