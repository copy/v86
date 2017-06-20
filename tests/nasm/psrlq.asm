global _start

section .data
	align 16
myquad:
	dq	0x8d0000ceadad00ff
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
	movq		mm3, [myquad]
	movq		mm4, [myquad]
	movq		mm6, [myquad]

	psrlq		mm0, [shift1]
	psrlq		mm1, [shift2]
	psrlq		mm2, 0x65
	psrlq		mm3, 0x25
	psrlq		mm4, 0x1F
	psrlq		mm6, 0x5

%include "footer.inc"
