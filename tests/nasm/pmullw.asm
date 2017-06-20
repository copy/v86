global _start

section .data
	align 16
quad1:
	dq	0x70ad80ad7fffffff
quad2:
	dq	0x71ae01ff0f00ffbe
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

	pmullw		mm0, [quad2]
	pmullw		mm0, [quad1]
	pmullw		mm1, mm2
	pmullw		mm2, [quad1]
	pmullw		mm3, [quad1]


%include "footer.inc"
