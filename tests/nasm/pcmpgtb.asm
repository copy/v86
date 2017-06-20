global _start

section .data
	align 16
quad1:
	dq	0x00ad00adad007fff
quad2:
	dq	0x7fff00428000ffff
quad3:
	dq	0x01008080f0f0ff42
quad4:
	dq	0x0000000000000000
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

	pcmpgtb	mm4, mm0
	pcmpgtb	mm5, mm1
	pcmpgtb	mm6, mm2
	pcmpgtb	mm7, mm3
	pcmpgtb	mm0, [quad2]
	pcmpgtb	mm1, [quad3]
	pcmpgtb	mm2, [quad4]
	pcmpgtb	mm3, [quad1]
	pcmpgtb	mm0, mm5
	pcmpgtb	mm1, mm6
	pcmpgtb	mm2, mm7
	pcmpgtb	mm3, mm4

%include "footer.inc"
