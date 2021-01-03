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
	movq		mm2, [dq1]
	movq		mm6, [dq1]

	movq		xmm0, [dq0]
	movq		xmm1, [dq0]
	movq		xmm2, [dq1]
	movq		xmm6, [dq1]

	psrad		mm0, [shift1]
	psrad		mm1, 0x18
	psrad		mm2, [shift2]
	psrad		mm6, 0x5

	psrad		xmm0, [shift1]
	psrad		xmm1, 0x18
	psrad		xmm2, [shift2]
	psrad		xmm6, 0x5

%include "footer.inc"
