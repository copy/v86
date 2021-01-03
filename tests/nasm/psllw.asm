global _start

section .data
	align 16
dq1:
	dq	0xad0000ceadad00ff
	dq	0xad0000ceadad00ff
dq2:
	dq	0x42ff88ff11aabbcc
	dq	0x42ff88ff11aabbcc
mydword:
	dd	0xcafebac0

align 16
shift1:
	dq	0x07
	dq	0
shift2:
	dq	-0x22
	dq	0
shift3:
	dq	8
	dq	0

%include "header.inc"

	movq		mm0, [dq1]
	movq		mm1, [dq1]
	movq		mm2, [dq1]
	movq		mm3, [dq2]
	movq		mm4, [dq2]
	movq		mm6, [dq2]

	movq		xmm0, [dq1]
	movq		xmm1, [dq1]
	movq		xmm2, [dq1]
	movq		xmm3, [dq2]
	movq		xmm4, [dq2]
	movq		xmm6, [dq2]

	psllw		mm0, [shift1]
	psllw		mm1, 0xff
	psllw		mm2, [shift2]
	psllw		mm3, 12
	psllw		mm4, [shift3]
	psllw		mm6, 0x5

	psllw		xmm0, [shift1]
	psllw		xmm1, 0xff
	psllw		xmm2, [shift2]
	psllw		xmm3, 12
	psllw		xmm4, [shift3]
	psllw		xmm6, 0x5

%include "footer.inc"

