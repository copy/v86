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
	movq		mm2, [mydq1]
	movq		mm6, [mydq1]

	movq		xmm0, [mydq0]
	movq		xmm1, [mydq0]
	movq		xmm2, [mydq1]
	movq		xmm6, [mydq1]

	psrld		mm0, [shift1]
	psrld		mm1, 0xff
	psrld		mm2, [shift0]
	psrld		mm6, 0x5

	psrld		xmm0, [shift1]
	psrld		xmm1, 0xff
	psrld		xmm2, [shift0]
	psrld		xmm6, 0x5

%include "footer.inc"
