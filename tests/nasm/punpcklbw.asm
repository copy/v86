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
	dq	0x00ad00adad007fff
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

	punpcklbw	mm4, mm0
	punpcklbw	mm5, mm1
	punpcklbw	mm6, mm2
	punpcklbw	mm7, mm3
	punpcklbw	mm0, [quad2]
	punpcklbw	mm1, [quad3]
	punpcklbw	mm2, [quad4]
	punpcklbw	mm3, [quad1]
	punpcklbw	mm0, mm5
	punpcklbw	mm1, mm6
	punpcklbw	mm2, mm7
	punpcklbw	mm3, mm4

%include "footer.inc"
