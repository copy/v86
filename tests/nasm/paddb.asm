global _start

section .data
	align 16
quad1:
	dq	0x70ad80ad7fffbaef
quad2:
	dq	0x71ae010f0f000dbe
quad3:
	dq	0xf100808080f0af42
quad4:
	dq	0xffffffffffffffff
mydword:
	dd	0xcafebabe
myaddress:
	dq	0x00adbeefc0de00ce

%include "header.inc"

	movq		mm0, [quad1]
	movq		mm1, [quad2]
	movq		mm2, [quad3]
	movq		mm3, [quad2]
	movq		mm4, [quad4]

	paddb		mm0, [quad2]
	paddb		mm0, [quad1]
	paddb		mm1, mm2
	paddb		mm2, [quad1]
	paddb		mm3, [quad1]
	paddb		mm4, [quad4]


%include "footer.inc"
