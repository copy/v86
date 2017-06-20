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
	dq	-0x22

%include "header.inc"

	movq		mm0, [myquad]
	movq		mm1, [myquad]
	movq		mm2, [myquad]
	movq		mm6, [myquad]

	pslld		mm0, [shift1]
	pslld		mm1, 0x20
	pslld		mm2, [shift2]
	pslld		mm6, 0x5

%include "footer.inc"
