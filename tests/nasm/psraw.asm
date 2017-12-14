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

	psraw		mm0, [shift1]
	psraw		mm1, 18
	psraw		mm2, [shift0]
	psraw		mm6, 0x5

	psraw		xmm0, [shift1]
	psraw		xmm1, 18
	psraw		xmm2, [shift0]
	psraw		xmm6, 0x5

%include "footer.inc"
