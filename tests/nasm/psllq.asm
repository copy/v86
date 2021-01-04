global _start

section .data
	align 16
dq0:
	dq	0x0102030405060708
	dq	0xffffaaaabbbbcccc
dq1:
	dq	0x8d0000ceadad00ff
	dq	0x0123456789abcdef
mydword:
	dd	0xcafebac0

align 16
shift1:
	dq	0x07
	dq	0
shift2:
	dq	-0x22
	dq	0

%include "header.inc"

	movq		mm0, [dq0]
	movq		mm1, [dq0]
	movq		mm2, [dq0]
	movq		mm3, [dq1]
	movq		mm4, [dq1]
	movq		mm6, [dq1]

	movq		xmm0, [dq0]
	movq		xmm1, [dq0]
	movq		xmm2, [dq0]
	movq		xmm3, [dq1]
	movq		xmm4, [dq1]
	movq		xmm6, [dq1]

	psllq		mm0, [shift1]
	psllq		mm1, [shift2]
	psllq		mm2, 50
	psllq		mm3, 28
	psllq		mm4, 68
	psllq		mm6, 0x5

	psllq		xmm0, [shift1]
	psllq		xmm1, [shift2]
	psllq		xmm2, 50
	psllq		xmm3, 28
	psllq		xmm4, 68
	psllq		xmm6, 0x5

%include "footer.inc"

