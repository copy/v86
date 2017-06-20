global _start

section .data
	align 16
quad1:
	dq	0x00ad00adad007fff
quad2:
	dq	0x7fff00428000ffff
quad3:
	dq	0x01008080f0f0ff42
mydword:
	dd	0xcafebabe
myaddress:
	dq	0x00adbeefc0de00ce

%include "header.inc"

	movq		mm0, [quad1]
	movq		mm1, [quad2]
	movq		mm2, [quad3]
	movq		mm3, [quad2]

	packsswb	mm0, [quad3]
	packsswb	mm0, [quad1]
	packsswb	mm1, [quad3]
	packsswb	mm2, [quad1]
	packsswb	mm3, [quad1]


%include "footer.inc"
