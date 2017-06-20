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

	psubw		mm1, [quad2]
	psubw		mm1, mm2
	psubw		mm2, [quad1]
	psubw		mm2, mm3
	psubw		mm3, [quad3]
	psubw		mm3, mm4
	psubw		mm4, [quad1]
	psubw		mm4, mm1
	psubw		mm4, mm3


%include "footer.inc"
