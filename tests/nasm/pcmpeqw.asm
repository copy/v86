global _start

section .data
	align 16
quad1:
	dq	0x70ad80adad007fff
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

	pcmpeqw	mm0, [quad2]
	pcmpeqw	mm0, [quad1]
	pcmpeqw	mm1, mm2
	pcmpeqw	mm2, [quad1]
	pcmpeqw	mm3, [quad1]


%include "footer.inc"
