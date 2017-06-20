global _start

section .data
	align 16
myquad:
	dq	0xad0000ceadad00ff
mydword:
	dd	0xcafebac0
shift1:
	dq	0x07
shift2:
	dq	-23

%include "header.inc"

	movq		mm0, [myquad]
	movq		mm1, [myquad]
	movq		mm2, [myquad]
	movq		mm6, [myquad]

	psraw		mm0, [shift1]
	psraw		mm1, 0xc
	psraw		mm2, [shift2]
	psraw		mm6, 0x5

%include "footer.inc"
