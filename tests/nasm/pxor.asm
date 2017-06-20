global _start

section .data
	align 16
quad1:
	dq	0xad0000ceadad00ff
quad2:
	dq	0xffffffffffffffff
quad3:
	dq	0x0000000000000000
quad4:
	dq	0x7fff8000ffff0808
myquad:
	dq	0xad0000ceadad00ff
mydword:
	dd	0xcafebabe
myaddress:
	dq	0x00adbeefc0de00ce

%include "header.inc"

	movq		mm0, [quad1]
	movq		mm1, [quad2]
	movq		mm2, [quad3]
	movq		mm3, [quad4]
	movq		mm4, [quad1]
	movq		mm5, [quad2]
	movq		mm6, [quad3]
	movq		mm7, [quad4]

	pxor	mm4, mm0
	pxor	mm5, mm1
	pxor	mm6, mm2
	pxor	mm7, mm3
	pxor	mm0, [quad2]
	pxor	mm1, [quad3]
	pxor	mm2, [quad4]
	pxor	mm3, [quad1]
	pxor	mm0, mm5
	pxor	mm1, mm6
	pxor	mm2, mm7
	pxor	mm3, mm4

%include "footer.inc"
