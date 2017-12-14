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
shift0:
	dq	0x07
shift1:
	dq	-0x22

align 16
shift2:
	dq	0x07
	dq	0
shift3:
	dq	-0x22
	dq	0

%include "header.inc"

	movq		mm0, [mydq0]
	movq		mm1, [mydq0]
	movq		mm2, [mydq1]
	movq		mm6, [mydq1]

	movq		xmm0, [mydq0]
	movq		xmm1, [mydq0]
	movq		xmm2, [mydq1]
	movq		xmm6, [mydq1]

	pslld		mm0, [shift0]
	pslld		mm1, 30
	pslld		mm2, [shift1]
	pslld		mm6, 0x5

	pslld		xmm0, [shift2]
	pslld		xmm1, 30
	pslld		xmm2, [shift3]
	pslld		xmm6, 0x5

%include "footer.inc"
