global _start

section .data
	align 16
quad1:
	dq	0x70ad80ad7fffffff
quad2:
	dq	0x7fff00428000ffff
quad3:
	dq	0xf100808080f0ff42
mydword:
	dd	0xcafebabe
myaddress:
	dq	0x00adbeefc0de00ce

%include "header.inc"

	movq		mm0, [quad1]
	movq		mm1, [quad2]
	movq		mm2, [quad3]
	movq		mm3, [quad2]

	pcmpgtd	mm0, [quad2]
	pcmpgtd	mm0, [quad1]
	pcmpgtd	mm1, mm2
	pcmpgtd	mm2, [quad1]
	pcmpgtd	mm3, [quad1]


%include "footer.inc"

