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
mydword:
	dd	0xcafebabe

%include "header.inc"

	movq		mm0, [quad1]
	movq		mm1, [quad2]
	movq		mm2, [quad3]
	movq		mm3, [quad4]
	movq		mm4, [quad1]

	pand		mm1, [quad2]
	pand		mm1, mm2
	pand		mm2, [quad1]
	pand		mm2, mm3
	pand		mm3, [quad3]
	pand		mm3, mm4
	pand		mm4, [quad1]
	pand		mm4, mm1
	pand		mm4, mm3


%include "footer.inc"
