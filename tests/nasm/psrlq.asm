global _start

section .data
	align 16
mydq0:
	dq	0xad0000ceadad00ff
	dq	0xff00dadaec0000da
mydq1:
	dq	0x0102030405060708
	dq	0x090a0b0c0d0e0f10
mydword:
	dd	0xcafebac0

align 16
shift0:
	dq	0x07
	dq	0
shift1:
	dq	-0x22
	dq	0

%include "header.inc"

	movq		mm0, [mydq0]
	movq		mm1, [mydq0]
	movq		mm2, [mydq0]
	movq		mm3, [mydq1]
	movq		mm4, [mydq1]
	movq		mm6, [mydq1]

	movq		xmm0, [mydq0]
	movq		xmm1, [mydq0]
	movq		xmm2, [mydq0]
	movq		xmm3, [mydq1]
	movq		xmm4, [mydq1]
	movq		xmm6, [mydq1]

	psrlq		mm0, [shift1]
	psrlq		mm1, [shift0]
	psrlq		mm2, 0x65
	psrlq		mm3, 0x25
	psrlq		mm4, 0x1F
	psrlq		mm6, 0x5

	movq		xmm0, [mydq0]
	movq		xmm1, [mydq0]
	movq		xmm2, [mydq1]
	movq		xmm3, [mydq1]
	movq		xmm6, [mydq1]

	psrlq		xmm0, [shift1]
	psrlq		xmm1, [shift0]
	psrlq		xmm2, 0x65
	psrlq		xmm3, 0x25
	psrlq		xmm4, 0x1F
	psrlq		xmm6, 0x5

%include "footer.inc"
